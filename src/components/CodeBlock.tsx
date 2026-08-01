import { isValidElement, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { CopyButton } from './CopyButton'
import { SvgFigure } from './SvgFigure'

/** Flattens a rendered markdown subtree (highlight.js wraps tokens in spans) back to plain text. */
function nodeText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children)
  return ''
}

const LANGUAGE_LABELS: Record<string, string> = {
  bash: 'Bash',
  c: 'C',
  cpp: 'C++',
  cs: 'C#',
  css: 'CSS',
  diff: 'Diff',
  go: 'Go',
  html: 'HTML',
  java: 'Java',
  javascript: 'JavaScript',
  js: 'JavaScript',
  json: 'JSON',
  jsx: 'JSX',
  kotlin: 'Kotlin',
  markdown: 'Markdown',
  md: 'Markdown',
  php: 'PHP',
  plaintext: 'Text',
  py: 'Python',
  python: 'Python',
  rb: 'Ruby',
  ruby: 'Ruby',
  rs: 'Rust',
  rust: 'Rust',
  sh: 'Shell',
  shell: 'Shell',
  sql: 'SQL',
  swift: 'Swift',
  toml: 'TOML',
  ts: 'TypeScript',
  tsx: 'TSX',
  typescript: 'TypeScript',
  xml: 'XML',
  yaml: 'YAML',
  yml: 'YAML',
}

/**
 * Replaces the markdown `<pre>` renderer with a ChatGPT-style framed block:
 * a header carrying the language name and a copy button, then the code.
 *
 * `svg` is the one language that does not get a code block. It is routed to
 * `SvgFigure` and drawn, which is the whole point of the diagram path — the
 * model writes a figure as source and the reader sees a figure. The source is
 * still one click away there, so nothing is hidden; and because this is a
 * fenced block rather than raw HTML, `react-markdown` never has to be given
 * `rehype-raw`, and every other kind of markup in a reply stays inert.
 */
export function CodeBlock({ children, ...preProps }: ComponentPropsWithoutRef<'pre'>) {
  const code = Array.isArray(children) ? children[0] : children
  const codeClass = isValidElement<{ className?: string }>(code)
    ? (code.props.className ?? '')
    : ''
  const lang = /language-([\w+#-]+)/.exec(codeClass)?.[1]?.toLowerCase()
  const text = nodeText(children)

  if (lang === 'svg') return <SvgFigure source={text} highlighted={children} />

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="text-xs text-ink-2">
          {lang ? (LANGUAGE_LABELS[lang] ?? lang) : 'Code'}
        </span>
        <CopyButton text={text} label="Copy code" withCaption size={13} />
      </div>
      <pre {...preProps}>{children}</pre>
    </div>
  )
}
