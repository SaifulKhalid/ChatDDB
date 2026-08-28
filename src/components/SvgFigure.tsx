import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  Code,
  Download,
  FileImage,
  Image as ImageIcon,
  Maximize2,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { CopyButton } from './CopyButton'
import { useStreaming } from '../lib/streamingContext'

/** How the figure should currently be presented. */
type Status = 'drawing' | 'ready' | 'unrenderable'

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
  const [fullscreen, setFullscreen] = useState(false)

  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
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

  if (!complete && !streaming && source.trim().length === 0) return null

  const stalled = !complete && !streaming
  const sourceShown = showSource || stalled || status === 'unrenderable'

  return (
    <>
      <figure className="svg-figure relative group">
        <div className="code-block-header flex items-center justify-between">
          <span className="text-xs text-ink-2 font-medium">
            {stalled ? 'Figure (incomplete)' : 'Figure · Interactive Diagram'}
          </span>
          <div className="flex items-center gap-0.5">
            {complete && (
              <button
                type="button"
                onClick={() => setShowSource((v) => !v)}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-ink-2 hover:bg-surface-3 hover:text-ink transition-colors"
                aria-label={showSource ? 'Show the figure' : 'Show the SVG source'}
                title={showSource ? 'Show the figure' : 'Show the SVG source'}
              >
                {showSource ? <ImageIcon size={13} /> : <Code size={13} />}
                <span className="text-xs">{showSource ? 'Figure' : 'Source'}</span>
              </button>
            )}
            {status === 'ready' && (
              <>
                <button
                  type="button"
                  onClick={() => setFullscreen(true)}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-ink-2 hover:bg-surface-3 hover:text-ink transition-colors"
                  aria-label="Fullscreen zoom view"
                  title="Fullscreen zoom & pan"
                >
                  <Maximize2 size={13} />
                  <span className="text-xs">Expand</span>
                </button>
                <DownloadActions source={source} name={caption} />
              </>
            )}
            <CopyButton text={source} label="Copy SVG source" withCaption size={13} />
          </div>
        </div>

        <div className="svg-figure-canvas" hidden={sourceShown}>
          <div ref={hostRef} className="overflow-x-auto py-2" />
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

      {/* Fullscreen Zoom / Pan Modal */}
      {fullscreen && (
        <FullscreenViewer
          source={source}
          caption={caption}
          onClose={() => setFullscreen(false)}
        />
      )}
    </>
  )
}

function FullscreenViewer({
  source,
  caption,
  onClose,
}: {
  source: string
  caption: string | null
  onClose: () => void
}) {
  const [scale, setScale] = useState(1)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface/95 backdrop-blur-md p-4 sm:p-6 animate-in fade-in duration-200">
      <div className="flex items-center justify-between border-b border-line pb-3">
        <div>
          <h3 className="text-sm font-bold text-ink">{caption ?? 'SVG Diagram Viewer'}</h3>
          <p className="text-xs text-ink-2">Zoom & inspect vector details</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-xl border border-line bg-surface-2 p-1 gap-1">
            <button
              onClick={() => setScale((s) => Math.max(0.4, Number((s - 0.2).toFixed(1))))}
              className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-3 hover:text-ink"
              title="Zoom out"
            >
              <ZoomOut size={15} />
            </button>
            <span className="px-2 text-xs font-mono text-ink tabular-nums">
              {Math.round(scale * 100)}%
            </span>
            <button
              onClick={() => setScale((s) => Math.min(3, Number((s + 0.2).toFixed(1))))}
              className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-3 hover:text-ink"
              title="Zoom in"
            >
              <ZoomIn size={15} />
            </button>
            <button
              onClick={() => setScale(1)}
              className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-3 hover:text-ink"
              title="Reset zoom"
            >
              <RotateCcw size={14} />
            </button>
          </div>

          <DownloadActions source={source} name={caption} />

          <button
            onClick={onClose}
            className="rounded-xl border border-line bg-surface-2 p-2 text-ink-2 hover:bg-surface-3 hover:text-ink"
            title="Close viewer (Esc)"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-auto flex items-center justify-center p-4 select-none"
      >
        <div
          style={{ transform: `scale(${scale})`, transformOrigin: 'center center' }}
          className="transition-transform duration-150 flex items-center justify-center max-w-full"
          dangerouslySetInnerHTML={{ __html: source }}
        />
      </div>
    </div>
  )
}

function FigureSkeleton() {
  return (
    <div className="flex h-48 items-center justify-center gap-2 text-sm text-ink-2">
      <span className="inline-block size-2 animate-pulse rounded-full bg-ink-2" />
      Drawing figure…
    </div>
  )
}

function DownloadActions({ source, name }: { source: string; name: string | null }) {
  const [downloadingPng, setDownloadingPng] = useState(false)

  function saveSvg() {
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${slug(name) || 'figure'}.svg`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function savePng() {
    setDownloadingPng(true)
    try {
      const svgBlob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(svgBlob)
      const img = new Image()
      img.crossOrigin = 'anonymous'

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = (e) => reject(e)
        img.src = url
      })

      const canvas = document.createElement('canvas')
      // Render at 2x resolution for retina sharpness
      const scale = 2
      const width = (img.width || 800) * scale
      const height = (img.height || 600) * scale
      canvas.width = width
      canvas.height = height

      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas 2D unsupported')

      // White background for PNG export
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)

      URL.revokeObjectURL(url)

      canvas.toBlob((blob) => {
        if (!blob) return
        const pngUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = pngUrl
        a.download = `${slug(name) || 'figure'}.png`
        a.click()
        URL.revokeObjectURL(pngUrl)
      }, 'image/png')
    } catch {
      // Fallback to SVG download on rasterization failure
      saveSvg()
    } finally {
      setDownloadingPng(false)
    }
  }

  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={saveSvg}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-ink-2 hover:bg-surface-3 hover:text-ink transition-colors"
        aria-label="Download SVG"
        title="Download SVG vector"
      >
        <Download size={13} />
        <span className="text-xs">SVG</span>
      </button>
      <button
        type="button"
        onClick={() => void savePng()}
        disabled={downloadingPng}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-ink-2 hover:bg-surface-3 hover:text-ink transition-colors disabled:opacity-50"
        aria-label="Export PNG"
        title="Export as high-res PNG image"
      >
        <FileImage size={13} />
        <span className="text-xs">{downloadingPng ? '…' : 'PNG'}</span>
      </button>
    </div>
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
