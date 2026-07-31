import { isValidElement, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { CopyButton } from './CopyButton'

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
 */
export function CodeBlock({ children, ...preProps }: ComponentPropsWithoutRef<'pre'>) {
  const code = Array.isArray(children) ? children[0] : children
  const codeClass = isValidElement<{ className?: string }>(code)
    ? (code.props.className ?? '')
    : ''
  const lang = /language-([\w+#-]+)/.exec(codeClass)?.[1]?.toLowerCase()
  const text = nodeText(children)

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
