/**
 * Sanitises model-authored SVG before it is streamed to a browser.
 *
 * The `draw_diagram` path lets the model emit SVG source that the frontend
 * renders as a real figure, which is the only way to draw a pole-zero plot or a
 * circuit schematic correctly — a diffusion model has no symbolic notion of an
 * axis. The cost of that capability is that a language model now writes markup
 * which lands in a page holding a live Firebase session. Prompt injection
 * through an uploaded PDF, or a jailbreak, would otherwise be a straight path to
 * XSS against the user's own account.
 *
 * ## Why HTMLRewriter and not a regex
 *
 * This is a real parser — the same lol-html engine Cloudflare wraps — so it sees
 * tag structure rather than text that looks like tags. That matters most for
 * `element.remove()`, which drops the element *and its entire subtree*. A naive
 * stripper that deletes `<foreignObject>` and `</foreignObject>` but keeps what
 * was between them unwraps a `<script>` into the output as live markup. Removing
 * the subtree closes that class of mXSS bypass outright.
 *
 * It also runs here, in the Worker, rather than only at render time. A
 * client-side pass can be bypassed by any bug in the client-side pass; this one
 * is the primary control and DOMPurify in `SvgFigure` is defence in depth.
 *
 * ## The allowlists are lowercase on purpose, and it is load-bearing
 *
 * HTMLRewriter reports `tagName` and attribute names *pre-lowercased*, whatever
 * the source casing. SVG, unlike HTML, is case-sensitive and its most important
 * attribute is `viewBox`. An allowlist spelled in natural SVG casing therefore
 * matches nothing: `has('viewbox')` misses `'viewBox'`, the attribute is
 * stripped from every figure, and the diagram silently loses its coordinate
 * system. A `<linearGradient>` disappears the same way.
 *
 * Deciding on the lowercased key costs nothing, because HTMLRewriter only
 * *decides* here — attributes it is not told to remove pass through as the
 * original source bytes, so real `viewBox` casing survives untouched in the
 * output. This was verified against the engine rather than assumed.
 *
 * ## Reference attributes, not just reference elements
 *
 * A `<clipPath>` or `<linearGradient>` in `<defs>` is inert on its own. What
 * activates it is `clip-path="url(#id)"` or `fill="url(#id)"` on the element
 * being clipped or filled — an *attribute*. Allowing the element without the
 * attribute leaves the definition in place doing nothing, so the figure renders
 * unshaded and nothing anywhere reports an error. Hence `clip-path`, `mask`,
 * `marker-*` and the gradient geometry attributes below.
 *
 * `id` has to be allowed for any of that to resolve at all. Ids are *not*
 * namespaced here: this function sees one figure with no idea how many others
 * share the page, so collision handling belongs to the renderer, which knows.
 * See `src/components/SvgFigure.tsx`.
 *
 * ## What is deliberately absent
 *
 * `<use>`, `<image>`, `<a>`, `<style>`, `<script>`, `<foreignObject>`, and every
 * animation element. `<style>` would reintroduce CSS `url()`; `<image>` and
 * `<use href>` fetch, which leaks the reader's IP to whoever the model names
 * even when it is not executable.
 *
 * `<textPath>` is absent for a different reason: it is the one useful element
 * that genuinely needs `href`, and `href` is the attribute most worth refusing
 * unconditionally. Scoping it to same-document `#fragment` references would be
 * sound, but curved text is not needed for any figure this feature exists to
 * draw. It stays out until something actually wants it, at which point the
 * scoped-fragment rule is the way in — not a blanket `href`.
 */

/** Elements kept, lowercased because that is how HTMLRewriter reports them. */
const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  // Shapes
  'path',
  'line',
  'circle',
  'ellipse',
  'rect',
  'polyline',
  'polygon',
  // Text
  'text',
  'tspan',
  // Arrowheads, gradients, clipping, hatching
  'marker',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'pattern',
])

/** Attributes kept, lowercased for the same reason. */
const ALLOWED_ATTRS = new Set([
  // Identity and grouping. `id` is required for url(#…) to resolve.
  'id',
  'class',
  'xmlns',
  // Geometry
  'd',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'points',
  'width',
  'height',
  'viewbox',
  'preserveaspectratio',
  'transform',
  // Paint
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'color',
  // Text
  'dx',
  'dy',
  'font-size',
  'font-family',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'letter-spacing',
  // References — the half that actually activates a def
  'clip-path',
  'mask',
  'marker-start',
  'marker-mid',
  'marker-end',
  // Gradients and their stops
  'gradientunits',
  'gradienttransform',
  'spreadmethod',
  'offset',
  'stop-color',
  'stop-opacity',
  // Markers
  'markerwidth',
  'markerheight',
  'markerunits',
  'refx',
  'refy',
  'orient',
  // Patterns
  'patternunits',
  'patterncontentunits',
  'patterntransform',
])

/**
 * Refuses anything larger than this outright.
 *
 * The probe's figures ran 1.8-3.8 kB; a genuinely complex schematic might reach
 * five times that. 64 kB is well clear of legitimate output and well short of a
 * payload worth streaming to a phone.
 */
export const MAX_SVG_BYTES = 64 * 1024

class SvgSanitizer {
  element(el: Element): void {
    if (!ALLOWED_ELEMENTS.has(el.tagName.toLowerCase())) {
      // Drops the subtree with it. Unwrapping instead is the mXSS bug.
      el.remove()
      return
    }
    for (const [name] of [...el.attributes]) {
      const lower = name.toLowerCase()
      // Event handlers are the reason this branch cannot be an allowlist miss
      // alone: `onload` is not in ALLOWED_ATTRS, so it is already removed, but
      // stating it separately keeps the intent legible to the next reader.
      if (!ALLOWED_ATTRS.has(lower) || lower.startsWith('on')) {
        el.removeAttribute(name)
      }
    }
  }
}

/**
 * Returns sanitised SVG, or `null` when the input is not usable as a figure.
 *
 * `null` is a real answer and callers must handle it: it means "show the source
 * instead", never "show nothing". A figure that fails to sanitise is a bug worth
 * seeing, and a blank frame is the one outcome that hides it.
 */
export async function sanitizeSvg(source: string): Promise<string | null> {
  const trimmed = source.trim()
  if (!trimmed.startsWith('<svg')) return null
  if (trimmed.length > MAX_SVG_BYTES) return null

  const res = new Response(trimmed, { headers: { 'Content-Type': 'text/html' } })
  const cleaned = await new HTMLRewriter().on('*', new SvgSanitizer()).transform(res).text()

  // The root itself can be removed — an input whose outer element was not `svg`
  // after parsing, for instance. Anything without a root is not renderable.
  if (!cleaned.includes('<svg')) return null
  return cleaned.trim()
}
