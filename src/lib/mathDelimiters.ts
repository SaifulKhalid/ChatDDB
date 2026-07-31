/**
 * LaTeX delimiter normalisation for the markdown pipeline.
 *
 * `remark-math` only recognises `$…$` (inline) and `$$…$$` (display). Models
 * routinely emit the LaTeX bracket forms instead — `\[ … \]` for display and
 * `\( … \)` for inline — so those have to be rewritten before parsing or they
 * reach the reader as literal `[ x_1(t)=v_C(t) ]`.
 *
 * This is a plain string transform rather than a remark plugin on purpose:
 * `remark-math` tokenises dollars during the micromark parse, so an mdast
 * transformer would run strictly too late to feed it. And by the time an mdast
 * exists, CommonMark escaping has already swallowed the backslashes — `\[` is
 * now an ordinary `[` in a text node, indistinguishable from prose brackets.
 *
 * Both bracket forms rewrite to `$$` because `singleDollarTextMath` is off:
 * enabling single-dollar math turns "it costs $5 and then $10 later" into a
 * formula, which is a worse regression than not accepting hand-typed `$x$`.
 * Nothing is lost by collapsing to one delimiter — `$$…$$` renders inline when
 * it shares a line with text and display when it stands alone, so the
 * display/inline distinction survives.
 */

interface Span {
  start: number
  end: number
}

interface Edit {
  start: number
  end: number
  text: string
}

const CLOSER_FOR: Record<string, string> = { '[': ']', '(': ')' }

/** `\[`, `\]`, `\(`, `\)` — the capture is the bracket itself. */
const DELIMITER = /\\([[\]()])/g

/** A backtick run and everything up to the next run of the same length. */
const INLINE_CODE = /(`+)[\s\S]*?\1/g

/** Fenced code blocks as `[start, end)` offsets. */
function fencedSpans(src: string): Span[] {
  const spans: Span[] = []
  let offset = 0
  let open: { start: number; marker: string; width: number } | null = null

  for (const line of src.split('\n')) {
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (!open) {
        open = { start: offset, marker: fence[1][0], width: fence[1].length }
      } else if (fence[1][0] === open.marker && fence[1].length >= open.width) {
        spans.push({ start: open.start, end: offset + line.length })
        open = null
      }
    }
    offset += line.length + 1
  }
  // An unterminated fence — mid-stream, most likely — runs to the end. Treating
  // it as still open is the safe direction: we skip rewriting rather than
  // rewriting inside what will turn out to be code.
  if (open) spans.push({ start: open.start, end: src.length })
  return spans
}

function covered(spans: Span[], pos: number): boolean {
  for (const span of spans) if (pos >= span.start && pos < span.end) return true
  return false
}

/**
 * The rewrite for one matched delimiter pair.
 *
 * A whole-line `\[ … \]` is display math, but `$$ … $$` on a single line parses
 * as *inline* math. So that one case gets broken across three lines — carrying
 * the original indentation, because an unindented `$$` inside a list item ends
 * the list and starts a second `<ol start="2">` after the formula.
 */
function pairEdits(src: string, openStart: number, closeStart: number): Edit[] {
  const openEnd = openStart + 2
  const closeEnd = closeStart + 2
  const inner = src.slice(openEnd, closeStart)

  const lineStart = src.lastIndexOf('\n', openStart - 1) + 1
  const indent = src.slice(lineStart, openStart)
  const lineEnd = src.indexOf('\n', closeEnd)
  const trailing = src.slice(closeEnd, lineEnd === -1 ? src.length : lineEnd)

  const oneLine = !inner.includes('\n')
  const ownsLine = /^[ \t]*$/.test(indent) && /^[ \t]*$/.test(trailing)

  if (oneLine && ownsLine) {
    return [
      { start: openStart, end: closeEnd, text: `$$\n${indent}${inner.trim()}\n${indent}$$` },
    ]
  }
  return [
    { start: openStart, end: openEnd, text: '$$' },
    { start: closeStart, end: closeEnd, text: '$$' },
  ]
}

/**
 * Rewrites balanced `\[…\]` and `\(…\)` to `$$…$$`, leaving code spans, fenced
 * blocks, and unbalanced delimiters untouched.
 */
export function normalizeMathDelimiters(src: string): string {
  // Fast path. Most messages contain no bracket math at all, and this runs on
  // every re-render of a streaming message.
  if (!src.includes('\\[') && !src.includes('\\(')) return src

  const fenced = fencedSpans(src)
  const protectedSpans = fenced.slice()
  INLINE_CODE.lastIndex = 0
  for (let m = INLINE_CODE.exec(src); m; m = INLINE_CODE.exec(src)) {
    if (!covered(fenced, m.index)) {
      protectedSpans.push({ start: m.index, end: m.index + m[0].length })
    }
  }

  const delimiters: { start: number; char: string }[] = []
  DELIMITER.lastIndex = 0
  for (let m = DELIMITER.exec(src); m; m = DELIMITER.exec(src)) {
    if (!covered(protectedSpans, m.index)) delimiters.push({ start: m.index, char: m[1] })
  }

  const edits: Edit[] = []
  for (let i = 0; i < delimiters.length; i++) {
    const closer = CLOSER_FOR[delimiters[i].char]
    // A stray `\]` or `\)` with no opener is an escaped bracket in prose.
    if (!closer) continue
    let j = i + 1
    while (j < delimiters.length && delimiters[j].char !== closer) j++
    // Unbalanced, or the closer has not streamed in yet. Leave the tail alone;
    // the next token will bring it.
    if (j === delimiters.length) break
    edits.push(...pairEdits(src, delimiters[i].start, delimiters[j].start))
    i = j
  }

  if (edits.length === 0) return src

  let out = ''
  let cursor = 0
  for (const edit of edits) {
    out += src.slice(cursor, edit.start) + edit.text
    cursor = edit.end
  }
  return out + src.slice(cursor)
}
