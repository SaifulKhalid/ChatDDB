import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Code, Download, Image as ImageIcon } from 'lucide-react'
import { CopyButton } from './CopyButton'
import { useStreaming } from '../lib/streamingContext'

/**
 * Renders a ```` ```svg ```` block as an actual figure.
 *
 * This is the display half of the diagram path. The model draws in SVG because
 * a diffusion model cannot: it has no symbolic notion of an axis, so a pole-zero
 * plot or a labelled schematic comes back as plausible-looking nonsense. Drawing
 * with coordinates makes the figure correct by construction, and it costs one
 * fenced code block.
 *
 * ## The sanitiser here is the second one, not the only one
 *
 * `worker/lib/sanitizeSvg.ts` has already cleaned this markup with
 * HTMLRewriter, before it was streamed or persisted. That is the primary
 * control. This pass exists because the page holds a live Firebase session, so
 * one bug in one sanitiser should not be enough — and it is deliberately a
 * *different* implementation rather than a shared allowlist, because two layers
 * that share their rules also share their blind spots.
 *
 * DOMPurify is loaded dynamically so that readers who never see a figure never
 * download it.
 *
 * ## Ids have to be rewritten, and only this side can do it
 *
 * `url(#grad)` is how a gradient, clip path or arrowhead is applied. The Worker
 * sanitiser allows `id` for that reason, and notes that it cannot solve
 * collisions: it sees one figure at a time with no idea what else is on the
 * page. Two figures in one reply that both call their gradient `g` would
 * otherwise resolve to whichever landed in the DOM first — silently, and
 * differently depending on scroll order. Here there is a unique id per instance
 * to prefix with, so both the `id` attributes and every `url(#…)` that points at
 * them are rewritten together.
 */

/** How the figure should currently be presented. */
type Status = 'drawing' | 'ready' | 'unrenderable'

/**
 * Belt and braces over DOMPurify's SVG profile, which is broader than ours.
 *
 * Its defaults would keep `<use>` and `<image>`, which fetch — leaking the
 * reader's IP to whatever host the model named, even though neither executes.
 * The Worker already drops them; restating it costs one array.
 */
const FORBID_TAGS = ['foreignObject', 'style', 'image', 'use', 'a', 'set']
const FORBID_ATTR = ['href', 'xlink:href']

interface SvgFigureProps {
  /** The raw fence contents, already sanitised server-side. */
  source: string
  /** The same text as highlighted markdown nodes, for the source view. */
  highlighted: ReactNode
}

export function SvgFigure({ source, highlighted }: SvgFigureProps) {
  const streaming = useStreaming()
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Status>('drawing')
  const [caption, setCaption] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(false)

  // `useId` is unique per component instance and stable across re-renders, which
  // is exactly the scope an id prefix needs. Stripping React's delimiters keeps
  // it valid inside `url(#…)`.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')

  // The gate in `worker/sse.ts` withholds a figure until its closing fence
  // arrives, so an unterminated root here means the stream is still open (or
  // ended badly), never that the next token is about to complete it.
  const complete = /<\/svg\s*>/i.test(source)

  useEffect(() => {
    if (!complete) {
      setStatus('drawing')
      return
    }
    let live = true

    void (async () => {
      const { default: DOMPurify } = await import('dompurify')
      if (!live) return

      const fragment = DOMPurify.sanitize(source, {
        USE_PROFILES: { svg: true },
        FORBID_TAGS,
        FORBID_ATTR,
        RETURN_DOM_FRAGMENT: true,
      })

      const root = fragment.querySelector('svg')
      if (!root) {
        setStatus('unrenderable')
        return
      }

      namespaceIds(fragment, uid)

      // The model is asked to open every figure with a <title>; it is the only
      // description of the drawing that exists, so it serves as both the
      // accessible name and the printed caption.
      const title = root.querySelector('title')?.textContent?.trim() ?? null
      root.setAttribute('role', 'img')

      const host = hostRef.current
      if (!host) return
      host.replaceChildren(fragment)
      setCaption(title && title.length > 0 ? title : null)
      setStatus('ready')
    })()

    return () => {
      live = false
    }
  }, [source, complete, uid])

  // Nothing to draw and nothing still coming: the gate emits its own visible
  // note in this case, so a second empty frame would only add noise.
  if (!complete && !streaming && source.trim().length === 0) return null

  // A figure that stopped mid-tag after the stream ended. Showing the source is
  // the honest fallback — the same rule `sanitizeSvg` follows when it returns
  // null. A spinner here would wait forever.
  const stalled = !complete && !streaming
  const sourceShown = showSource || stalled || status === 'unrenderable'

  return (
    <figure className="svg-figure">
      <div className="code-block-header">
        <span className="text-xs text-ink-2">{stalled ? 'Figure (incomplete)' : 'Figure'}</span>
        <div className="flex items-center">
          {complete && (
            <button
              type="button"
              onClick={() => setShowSource((v) => !v)}
              className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-ink-2 hover:bg-surface-3 hover:text-ink"
              aria-label={showSource ? 'Show the figure' : 'Show the SVG source'}
              title={showSource ? 'Show the figure' : 'Show the SVG source'}
            >
              {showSource ? <ImageIcon size={13} /> : <Code size={13} />}
              <span className="text-xs">{showSource ? 'Figure' : 'Source'}</span>
            </button>
          )}
          {status === 'ready' && <DownloadButton source={source} name={caption} />}
          <CopyButton text={source} label="Copy SVG source" withCaption size={13} />
        </div>
      </div>

      {/* Kept mounted even while the source is shown, so toggling back does not
          re-run the sanitiser or lose the rendered tree. */}
      <div className="svg-figure-canvas" hidden={sourceShown}>
        <div ref={hostRef} />
        {status === 'drawing' && <FigureSkeleton />}
      </div>

      {sourceShown && (
        <>
          {status === 'unrenderable' && (
            <p className="border-b border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">
              This block could not be drawn as a figure, so its source is shown instead.
            </p>
          )}
          <pre>{highlighted}</pre>
        </>
      )}

      {caption && !sourceShown && <figcaption>{caption}</figcaption>}
    </figure>
  )
}

/**
 * A fixed-height placeholder, matching the reserved box `GeneratedImage` uses.
 *
 * The point is that it has a height. The gate opens the fence the moment it sees
 * one, so this appears immediately and the figure fills in underneath it; a
 * zero-height placeholder would let the transcript jump when the drawing lands,
 * moving whatever the reader was looking at.
 */
function FigureSkeleton() {
  return (
    <div className="flex h-48 items-center justify-center gap-2 text-sm text-ink-2">
      <span className="inline-block size-2 animate-pulse rounded-full bg-ink-2" />
      Drawing figure…
    </div>
  )
}

/** Saves the figure as a `.svg` file — these end up in lab reports. */
function DownloadButton({ source, name }: { source: string; name: string | null }) {
  return (
    <button
      type="button"
      onClick={() => {
        const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }))
        const a = document.createElement('a')
        a.href = url
        a.download = `${slug(name) || 'figure'}.svg`
        a.click()
        URL.revokeObjectURL(url)
      }}
      className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-ink-2 hover:bg-surface-3 hover:text-ink"
      aria-label="Download SVG"
      title="Download SVG"
    >
      <Download size={13} />
      <span className="text-xs">Save</span>
    </button>
  )
}

function slug(name: string | null): string {
  if (!name) return ''
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * Prefixes every `id` in the fragment, then repoints everything that referenced
 * one.
 *
 * Both halves are required and neither is sufficient. Renaming the ids alone
 * breaks every gradient and arrowhead in the figure; rewriting the references
 * alone points them at nothing. The reference scan covers all attributes rather
 * than a fixed list (`fill`, `clip-path`, `marker-end`, …) because the set of
 * attributes that can hold a `url(#…)` is longer than it looks, and missing one
 * fails silently.
 */
function namespaceIds(fragment: DocumentFragment, uid: string): void {
  const renamed = new Map<string, string>()

  for (const el of fragment.querySelectorAll('[id]')) {
    const original = el.id
    if (!original) continue
    const next = `${uid}-${original}`
    renamed.set(original, next)
    el.id = next
  }
  if (renamed.size === 0) return

  for (const el of fragment.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (!attr.value.includes('#')) continue
      const rewritten = attr.value.replace(
        /url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g,
        (whole, quote: string, id: string) =>
          renamed.has(id) ? `url(${quote}#${renamed.get(id)}${quote})` : whole,
      )
      if (rewritten !== attr.value) el.setAttribute(attr.name, rewritten)
    }
  }
}
