import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import type { Components, Options } from 'react-markdown'
import { CodeBlock } from './CodeBlock'
import { MarkdownErrorBoundary } from './MarkdownErrorBoundary'
import { StreamingContext } from '../lib/streamingContext'
import { normalizeMathDelimiters } from '../lib/mathDelimiters'

const MARKDOWN_COMPONENTS: Components = { pre: CodeBlock }
const REMARK_PLUGINS: Options['remarkPlugins'] = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]]
const REHYPE_PLUGINS: Options['rehypePlugins'] = [[rehypeKatex, { throwOnError: false, errorColor: 'currentColor' }], rehypeHighlight]
const TAIL_REHYPE: Options['rehypePlugins'] = [[rehypeKatex, { throwOnError: false, errorColor: 'currentColor' }], rehypeHighlight]

export function splitStableTail(normalized: string): { stable: string; tail: string } {
  if (!normalized) return { stable: '', tail: '' }
  let openStart = -1
  let openMarker = ''
  let openWidth = 0
  let offset = 0
  const lines = normalized.split('\n')
  for (const line of lines) {
    const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)
    if (m) {
      const marker = m[1][0]
      const width = m[1].length
      if (openStart === -1) { openStart = offset; openMarker = marker; openWidth = width }
      else if (marker === openMarker && width >= openWidth) { openStart = -1; openMarker = ''; openWidth = 0 }
    }
    offset += line.length + 1
  }
  if (openStart !== -1) return { stable: normalized.slice(0, openStart), tail: normalized.slice(openStart) }
  const lastBlank = normalized.lastIndexOf('\n\n')
  if (lastBlank !== -1 && lastBlank < normalized.length - 2) return { stable: normalized.slice(0, lastBlank + 2), tail: normalized.slice(lastBlank + 2) }
  return { stable: '', tail: normalized }
}

const StableBlock = memo(function StableBlock({ content }: { content: string }) {
  if (!content) return null
  return (
    <MarkdownErrorBoundary resetKey={content} fallback={<p className="whitespace-pre-wrap">{content}</p>}>
      <StreamingContext.Provider value={false}>
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
          {content}
        </ReactMarkdown>
      </StreamingContext.Provider>
    </MarkdownErrorBoundary>
  )
})

function RawFencePreview({ source }: { source: string }) {
  const firstLineEnd = source.indexOf('\n')
  const opener = firstLineEnd === -1 ? source : source.slice(0, firstLineEnd)
  const langMatch = /^\s*(`{3,}|~{3,})\s*([\w+#-]+)?/.exec(opener)
  const lang = langMatch?.[2]?.toLowerCase() ?? ''
  const body = firstLineEnd === -1 ? '' : source.slice(firstLineEnd + 1)
  const labelMap: Record<string, string> = {
    bash: 'Bash', python: 'Python', py: 'Python', typescript: 'TypeScript', ts: 'TypeScript', javascript: 'JavaScript', js: 'JavaScript', svg: 'Figure',
  }
  const label = lang ? (labelMap[lang] ?? lang) : 'Code'
  if (lang === 'svg') {
    return (
      <figure className="svg-figure relative group">
        <div className="code-block-header flex items-center justify-between">
          <span className="text-xs text-ink-2 font-medium">Figure · Drawing…</span>
        </div>
        <div className="px-3 py-6 text-center text-sm text-ink-2">
          <span className="inline-flex items-center gap-2">
            <span className="size-3 animate-pulse rounded-full bg-ink-2" aria-hidden /> Drawing figure…
          </span>
        </div>
        <div className="border-t border-line bg-surface-2">
          <pre className="m-0 border-0 rounded-none">
            <code className="block overflow-x-auto p-3 text-xs text-ink-2">{body || ' '}</code>
          </pre>
        </div>
      </figure>
    )
  }
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="text-xs text-ink-2">{label}</span>
        <span className="text-[11px] text-ink-2">Streaming…</span>
      </div>
      <pre><code>{body}</code></pre>
    </div>
  )
}

function TailBlock({ content }: { content: string }) {
  if (!content) return null
  const trimmedStart = content.trimStart()
  if (/^(```|~~~)/.test(trimmedStart)) {
    const idx = content.indexOf(trimmedStart.slice(0, 3))
    const fenceSource = idx >= 0 ? content.slice(idx) : content
    return <RawFencePreview source={fenceSource} />
  }
  return (
    <MarkdownErrorBoundary resetKey={content} fallback={<p className="whitespace-pre-wrap">{content}</p>}>
      <StreamingContext.Provider value={true}>
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={TAIL_REHYPE} components={MARKDOWN_COMPONENTS}>
          {content}
        </ReactMarkdown>
      </StreamingContext.Provider>
    </MarkdownErrorBoundary>
  )
}

export function StreamingMarkdown({ content, streaming }: { content: string; streaming: boolean }) {
  const normalized = useMemo(() => normalizeMathDelimiters(content), [content])
  if (!streaming) {
    return (
      <MarkdownErrorBoundary resetKey={normalized} fallback={<p className="whitespace-pre-wrap">{normalized}</p>}>
        <StreamingContext.Provider value={false}>
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
            {normalized}
          </ReactMarkdown>
        </StreamingContext.Provider>
      </MarkdownErrorBoundary>
    )
  }
  const { stable, tail } = useMemo(() => splitStableTail(normalized), [normalized])
  if (!stable) return <div className="streaming-wrap"><TailBlock content={tail} /></div>
  if (!tail) return <StableBlock content={stable} />
  return (
    <div className="streaming-wrap">
      <StableBlock content={stable} />
      <TailBlock content={tail} />
    </div>
  )
}

