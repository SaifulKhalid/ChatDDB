/**
 * Withholds ```` ```svg ```` blocks from the client stream until they are whole
 * and sanitised.
 *
 * The model writes figures as SVG source inline in its reply, which streams like
 * any other text. That is a problem in two directions. A half-written `<svg>` is
 * not renderable, so the frontend would have to guard against it anyway; and
 * text streamed straight through has never passed a sanitiser, which would make
 * the client-side pass the *primary* XSS control rather than defence in depth.
 *
 * Buffering the fenced block solves both, and costs nothing: the bytes held back
 * are precisely the bytes that could not have been drawn yet.
 *
 * ## This is not a violation of the "never restart an open stream" rule
 *
 * `failover.ts` refuses to retry a stream that has delivered bytes, because a
 * second provider cannot continue a sentence the first one started. Nothing here
 * restarts anything. The stream stays open and in order; some of its bytes
 * arrive later than they otherwise would.
 *
 * ## The placeholder is the opening fence itself
 *
 * When the gate sees ```` ```svg ````, it immediately emits ```` ```svg ````
 * with an empty body. The client already knows how to render that: an svg fence
 * with no closing `</svg>` is exactly the "drawing…" skeleton state in
 * `SvgFigure`. So the reader sees a figure frame appear and fill in, rather than
 * prose that stops for ten seconds for no visible reason — and it needs no new
 * SSE frame type, no protocol change, and nothing in `src/lib/api.ts`.
 *
 * ## Nothing is ever silently swallowed
 *
 * Two things can go wrong: the closing fence never arrives (the model hit its
 * token ceiling, or upstream dropped), or the buffer grows past what a figure
 * could legitimately need. Both end the same way — close the block with whatever
 * arrived, sanitise *that*, and append a visible note. A truncated figure is a
 * bad answer; a figure that vanishes with no trace is a bug report nobody can
 * file.
 *
 * Note the ordering: even the truncated remnant goes through `sanitizeSvg`
 * before it is emitted. Emitting the raw buffer on the error path would leave
 * one route by which unsanitised model markup reaches a browser, which is the
 * whole thing this gate exists to prevent.
 */

import { sanitizeSvg, MAX_SVG_BYTES } from './sanitizeSvg.ts'

/** Opening fence. Tolerates ```` ```svg ````, ```` ``` svg ````, and CRLF. */
const OPEN_FENCE = /```[ \t]*svg[ \t]*\r?\n/i
const CLOSE_FENCE = '```'

/**
 * How far back from the end of a chunk a partial fence marker is looked for.
 *
 * Text within this distance of the end is held rather than emitted, so a fence
 * split across two deltas is still recognised. Twelve covers ```` ``` svg \r\n ````
 * with the whitespace the regex tolerates; a fence padded wider than that and
 * *also* split mid-marker would be emitted as literal text, which renders as an
 * ordinary code block. Degraded, visible, and not a security hole — the gate is
 * what decides something is a figure, so text it never recognised was never
 * treated as one.
 */
const MARKER_WINDOW = 12

/**
 * Wall-clock ceiling on one figure, independent of size.
 *
 * Size alone is not enough: an upstream that stalls mid-figure would hold the
 * prose after it hostage for as long as the request timeout allows, having
 * bought none of the buffer back. `Date.now()` does advance across these calls
 * despite the Workers clock freeze, because the gate is only ever driven by a
 * stream read, which is I/O.
 */
const FIGURE_DEADLINE_MS = 30_000

/**
 * Size ceiling on the buffer, held below `sanitizeSvg`'s own limit.
 *
 * The headroom matters. An overflowing buffer is repaired with a closing tag
 * and then sanitised, and if the repaired candidate were still over
 * `MAX_SVG_BYTES` the sanitiser would reject it on length — so every oversized
 * figure would report as *unsafe* when what actually happened is that it ran
 * long. Cutting to a budget the sanitiser will accept keeps the diagnosis
 * honest, and usually salvages a partial drawing too.
 */
const MAX_FIGURE_BYTES = MAX_SVG_BYTES - 1024

const TRUNCATED_NOTE = '\n\n*(This figure was cut off before it finished drawing.)*\n'
const FAILED_NOTE = '\n\n*(A figure was dropped here because it could not be rendered safely.)*\n'

/**
 * `text` — passing prose through, watching for an opening fence.
 * `figure` — buffering SVG source, watching for the closing fence.
 * `skip` — a figure already ended early; discard its remaining bytes.
 *
 * `skip` is what stops an overflow from making a mess. Once the truncated figure
 * and its note have been emitted, the rest of the model's SVG is redundant — and
 * letting it fall back to `text` would dump raw markup into the prose and then
 * emit the model's own closing ``` as a stray unmatched fence.
 */
type Mode = 'text' | 'figure' | 'skip'

export class FigureGate {
  /** Text seen but not yet classified. */
  private carry = ''
  /** The figure body accumulated so far, in `figure` mode. */
  private figure = ''
  private mode: Mode = 'text'
  private openedAt = 0

  /** Feeds one upstream delta in. Returns the text the client should see now. */
  async push(text: string): Promise<string[]> {
    this.carry += text
    return this.drain(false)
  }

  /**
   * Ends the stream. Any unterminated figure is closed as truncated, and any
   * held-back marker tail is released — otherwise the last few characters of a
   * reply would be dropped whenever it happened to end near a backtick.
   */
  async flush(): Promise<string[]> {
    const out = await this.drain(true)
    if (this.mode === 'figure') out.push(...(await this.closeFigure(true)))
    if (this.mode === 'skip') this.carry = ''
    if (this.carry) {
      out.push(this.carry)
      this.carry = ''
    }
    this.mode = 'text'
    return out
  }

  private async drain(final: boolean): Promise<string[]> {
    const out: string[] = []

    for (;;) {
      if (this.mode === 'skip') {
        const close = this.carry.indexOf(CLOSE_FENCE)
        if (close >= 0) {
          this.carry = this.carry.slice(close + CLOSE_FENCE.length)
          this.mode = 'text'
          continue
        }
        // Drop everything except what could be a partial closing fence.
        this.carry = final ? '' : this.carry.slice(-(CLOSE_FENCE.length - 1))
        return out
      }

      if (this.mode === 'figure') {
        const close = this.carry.indexOf(CLOSE_FENCE)
        if (close >= 0) {
          this.figure += this.carry.slice(0, close)
          this.carry = this.carry.slice(close + CLOSE_FENCE.length)
          out.push(...(await this.closeFigure(false)))
          this.mode = 'text'
          continue
        }

        const hold = final ? 0 : Math.min(this.carry.length, CLOSE_FENCE.length - 1)
        this.figure += this.carry.slice(0, this.carry.length - hold)
        this.carry = this.carry.slice(this.carry.length - hold)

        if (this.overflowed()) {
          out.push(...(await this.closeFigure(true)))
          this.mode = 'skip'
          continue
        }
        return out
      }

      const match = OPEN_FENCE.exec(this.carry)
      if (match) {
        if (match.index > 0) out.push(this.carry.slice(0, match.index))
        this.carry = this.carry.slice(match.index + match[0].length)
        this.mode = 'figure'
        this.figure = ''
        this.openedAt = Date.now()
        // The skeleton. See the header: an unterminated svg fence *is* the
        // placeholder, so this needs no cooperation from the client.
        out.push('```svg\n')
        continue
      }

      // Hold back anything that might be the start of a fence split across
      // deltas. On the final pass there is no "later", so hold back nothing.
      const hold = final ? 0 : this.markerTail(this.carry)
      if (this.carry.length > hold) {
        out.push(this.carry.slice(0, this.carry.length - hold))
        this.carry = this.carry.slice(this.carry.length - hold)
      }
      return out
    }
  }

  /** True once this figure has outgrown either bound. */
  private overflowed(): boolean {
    if (this.figure.length > MAX_FIGURE_BYTES) return true
    return Date.now() - this.openedAt > FIGURE_DEADLINE_MS
  }

  /**
   * Emits the finished figure. The caller sets the next mode, because the two
   * call sites want different ones — a clean close resumes prose, an overflow
   * has to discard the rest of the block first.
   *
   * A remnant missing its closing tag is repaired *before* sanitising rather
   * than after: `sanitizeSvg` rejects anything it cannot parse as a figure, so
   * an unclosed root would be thrown away whole when it may well hold a usable
   * partial drawing.
   */
  private async closeFigure(truncated: boolean): Promise<string[]> {
    let candidate = this.figure.trim()
    this.figure = ''

    if (truncated) {
      // A single upstream delta can carry the whole reply, so the buffer may be
      // far past the bound rather than one chunk over it. Cut, then repair.
      if (candidate.length > MAX_FIGURE_BYTES) candidate = candidate.slice(0, MAX_FIGURE_BYTES)
      if (candidate.length > 0 && !candidate.includes('</svg>')) candidate += '</svg>'
    }

    const cleaned = candidate.length > 0 ? await sanitizeSvg(candidate) : null
    // A cut-off figure that will not sanitise is still a cut-off figure. Saying
    // "unsafe" there would send the reader looking for an attack that never
    // happened; the reason it is unusable is that it stopped early.
    if (!cleaned) return ['\n```\n', truncated ? TRUNCATED_NOTE : FAILED_NOTE]
    return [cleaned, '\n```\n', ...(truncated ? [TRUNCATED_NOTE] : [])]
  }

  /** Length of the trailing run that could still become an opening fence. */
  private markerTail(text: string): number {
    const from = Math.max(0, text.length - MARKER_WINDOW)
    const tick = text.indexOf('`', from)
    return tick === -1 ? 0 : text.length - tick
  }
}
