import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import type { Components, Options } from 'react-markdown'
import { Loader2, Pencil, RotateCcw } from 'lucide-react'
import type { Message } from '../types'
import type { PublicFile } from '../lib/apiTypes'
import { Logo } from './Logo'
import { CopyButton } from './CopyButton'
import { CodeBlock } from './CodeBlock'
import { MarkdownErrorBoundary } from './MarkdownErrorBoundary'
import { AttachmentChip, chipFromPublicFile } from './AttachmentChip'
import { useSignedImageUrl } from '../lib/fileUrl'
import { normalizeMathDelimiters } from '../lib/mathDelimiters'
import { StreamingContext } from '../lib/streamingContext'

const MARKDOWN_COMPONENTS: Components = { pre: CodeBlock }

/**
 * `singleDollarTextMath: false` keeps prose dollars literal — "$5 and then $10"
 * would otherwise parse as a formula. `\(…\)` inline math is normalised to `$$`
 * upstream by `normalizeMathDelimiters`, so nothing is lost.
 */
const REMARK_PLUGINS: Options['remarkPlugins'] = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
]

/**
 * `throwOnError: false` makes KaTeX emit a `.katex-error` span for malformed
 * LaTeX rather than throwing — which matters most mid-stream, when every
 * formula is briefly half-written.
 */
const REHYPE_PLUGINS: Options['rehypePlugins'] = [
  [rehypeKatex, { throwOnError: false, errorColor: 'currentColor' }],
  rehypeHighlight,
]

interface MessageItemProps {
  message: Message
  isLast: boolean
  /** True while any turn is generating — hides edit/regenerate affordances */
  busy: boolean
  onRegenerate?: () => void
  onEdit?: (id: string, content: string) => void
}

function UserMessage({
  message,
  busy,
  onEdit,
}: {
  message: Message
  busy: boolean
  onEdit?: (id: string, content: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const editing = draft !== null

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])

  useEffect(() => {
    if (editing) textareaRef.current?.focus()
  }, [editing])

  if (editing) {
    const submit = () => {
      const trimmed = draft.trim()
      setDraft(null)
      if (trimmed && trimmed !== message.content) onEdit?.(message.id, trimmed)
    }
    return (
      <div className="flex flex-col items-end gap-2">
        <div className="w-full rounded-3xl bg-bubble px-4 py-3 md:max-w-[85%]">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setDraft(null)
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
            rows={1}
            aria-label="Edit message"
            className="max-h-[50vh] w-full resize-none bg-transparent outline-none"
          />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <button
            onClick={() => setDraft(null)}
            className="rounded-full border border-line px-3.5 py-1.5 hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            className="rounded-full bg-ink px-3.5 py-1.5 text-surface hover:opacity-80"
          >
            Send
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="group flex flex-col items-end gap-1">
      <MessageAttachments message={message} />
      {/* An attachment-only message has no bubble to draw. */}
      {message.content.length > 0 && (
        <div className="max-w-[85%] rounded-3xl bg-bubble px-4 py-2.5 whitespace-pre-wrap">
          {message.content}
        </div>
      )}
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        {message.content.length > 0 && <CopyButton text={message.content} label="Copy message" />}
        {onEdit && !busy && (
          <button
            onClick={() => setDraft(message.content)}
            className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-3 hover:text-ink"
            aria-label="Edit message"
            title="Edit message"
          >
            <Pencil size={15} />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * The attachments that were sent with a message.
 *
 * Read-only: images resolve through short-lived signed URLs inside the chip, so
 * reopening a conversation days later re-mints rather than showing a broken image.
 */
function MessageAttachments({ message }: { message: Message }) {
  const attachments = message.attachments
  // Memoised because `chipFromPublicFile` mints a fresh `File`; a new identity on
  // every render would re-trigger the chip's signed-URL effect each time.
  const chips = useMemo(
    () => (attachments ?? []).filter((f) => f.origin !== 'generated').map(chipFromPublicFile),
    [attachments],
  )
  if (chips.length === 0) return null
  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
      {chips.map((chip) => (
        <AttachmentChip key={chip.localId} item={chip} compact />
      ))}
    </div>
  )
}

/**
 * A generated image, shown at size.
 *
 * Separate from `AttachmentChip` because the two answer different questions. A
 * chip says "this file came along with the message" and a 36px thumbnail is
 * enough for that. A generated image *is* the answer, so rendering it as a chip
 * would hide the only thing the user asked for.
 *
 * The signed URL and its one-shot expiry re-mint come from the shared hook, so
 * a conversation reopened after the 300-second TTL recovers here exactly as it
 * does in the chip.
 */
function GeneratedImage({ file }: { file: PublicFile }) {
  const { src, broken, onError } = useSignedImageUrl(file.id)

  if (broken) {
    return (
      <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2">
        This image is no longer available.
      </p>
    )
  }

  return (
    <figure className="my-2">
      {src ? (
        <img
          src={src}
          // The prompt is the only honest description we have of the pixels.
          alt={file.genPrompt ?? 'Generated image'}
          onError={onError}
          className="max-h-[420px] w-auto max-w-full rounded-xl border border-line"
        />
      ) : (
        // Fixed box rather than a bare spinner: without it the transcript reflows
        // when the image lands, jumping whatever the user was reading.
        <div className="flex aspect-square w-full max-w-sm items-center justify-center rounded-xl border border-line bg-surface-2">
          <Loader2 size={20} className="animate-spin text-ink-2" />
        </div>
      )}
      {file.genPrompt && (
        <figcaption className="mt-1.5 text-xs text-ink-2">{file.genPrompt}</figcaption>
      )}
    </figure>
  )
}

function AssistantMessage({
  message,
  isLast,
  onRegenerate,
}: {
  message: Message
  isLast: boolean
  onRegenerate?: () => void
}) {
  const showActions = !message.streaming && (message.content.length > 0 || !!message.error)
  // `\[…\]` / `\(…\)` → `$$…$$` before micromark sees the text; remark-math
  // tokenises dollars at parse time, so this cannot be a remark plugin.
  const source = useMemo(() => normalizeMathDelimiters(message.content), [message.content])
  const generated = useMemo(
    () => (message.attachments ?? []).filter((f) => f.origin === 'generated'),
    [message.attachments],
  )

  return (
    <div data-role="assistant" className="group flex gap-3 md:gap-4">
      <div className="mt-0.5 shrink-0">
        <Logo size={26} />
      </div>
      <div className="min-w-0 flex-1">
        {message.content.length === 0 && message.streaming ? (
          <div className="flex h-7 items-center" aria-label="Thinking">
            <span className="inline-block size-2.5 animate-pulse rounded-full bg-ink" />
          </div>
        ) : (
          <div className={`markdown ${message.streaming ? 'stream-cursor' : ''}`}>
            <MarkdownErrorBoundary
              resetKey={message.content}
              fallback={<p className="whitespace-pre-wrap">{message.content}</p>}
            >
              {/* `SvgFigure` is reached through the static components map, so it
                  has no props route back to the message. This is the one bit it
                  needs: whether an unfinished figure is still coming. */}
              <StreamingContext.Provider value={!!message.streaming}>
                <ReactMarkdown
                  remarkPlugins={REMARK_PLUGINS}
                  rehypePlugins={REHYPE_PLUGINS}
                  components={MARKDOWN_COMPONENTS}
                >
                  {source}
                </ReactMarkdown>
              </StreamingContext.Provider>
            </MarkdownErrorBoundary>
          </div>
        )}
        {generated.map((file) => (
          <GeneratedImage key={file.id} file={file} />
        ))}
        {message.error && (
          <p className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
            {message.error}
          </p>
        )}
        {showActions && (
          <div
            className={`mt-1 flex items-center gap-0.5 transition-opacity ${
              isLast ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100'
            }`}
          >
            {message.content.length > 0 && (
              <CopyButton text={message.content} label="Copy response" />
            )}
            {isLast && onRegenerate && (
              <button
                onClick={onRegenerate}
                className="rounded-lg p-1.5 text-ink-2 hover:bg-surface-3 hover:text-ink"
                aria-label={message.error ? 'Try again' : 'Regenerate response'}
                title={message.error ? 'Try again' : 'Regenerate response'}
              >
                <RotateCcw size={15} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export const MessageItem = memo(function MessageItem({
  message,
  isLast,
  busy,
  onRegenerate,
  onEdit,
}: MessageItemProps) {
  return message.role === 'user' ? (
    <UserMessage message={message} busy={busy} onEdit={onEdit} />
  ) : (
    <AssistantMessage message={message} isLast={isLast} onRegenerate={onRegenerate} />
  )
})
