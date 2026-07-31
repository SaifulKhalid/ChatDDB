import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

interface CopyButtonProps {
  text: string
  label?: string
  /** Show a "Copy" / "Copied" caption beside the icon (code-block headers) */
  withCaption?: boolean
  size?: number
}

/** Writes `text` to the clipboard, falling back to a hidden textarea on insecure origins. */
async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    /* fall through */
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
  } catch {
    /* nothing else to try */
  }
  ta.remove()
}

export function CopyButton({
  text,
  label = 'Copy',
  withCaption = false,
  size = 15,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <button
      type="button"
      onClick={() => {
        void writeClipboard(text).then(() => {
          setCopied(true)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1500)
        })
      }}
      className={`flex items-center gap-1 rounded-lg text-ink-2 hover:bg-surface-3 hover:text-ink ${
        withCaption ? 'px-1.5 py-1' : 'p-1.5'
      }`}
      aria-label={copied ? 'Copied' : label}
      title={label}
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
      {withCaption && <span className="text-xs">{copied ? 'Copied' : 'Copy'}</span>}
    </button>
  )
}
