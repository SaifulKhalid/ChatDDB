import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, ImagePlus, Paperclip, Square } from 'lucide-react'
import type { PendingAttachment } from './AttachmentChip'
import { AttachmentTray } from './AttachmentTray'

interface ComposerProps {
  disabled?: boolean
  streaming?: boolean
  onSend: (text: string, attachmentIds?: string[]) => void
  onStop: () => void
  attachments?: PendingAttachment[]
  onAttach?: (files: File[]) => void
  onRemoveAttachment?: (localId: string) => void
  canAttachImages?: boolean
  canAttachDocuments?: boolean
  maxAttachments?: number
  /** Hidden entirely when the deployment cannot generate images. */
  canGenerateImages?: boolean
  /** When true, submitting generates an image instead of sending a message. */
  imageMode?: boolean
  onToggleImageMode?: () => void
}

export function Composer({
  disabled,
  streaming,
  onSend,
  onStop,
  attachments,
  onAttach,
  onRemoveAttachment,
  canAttachImages,
  canAttachDocuments,
  maxAttachments = 4,
  canGenerateImages,
  imageMode,
  onToggleImageMode,
}: ComposerProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // flux-1-schnell is text-to-image only: it takes a prompt and nothing else, so
  // attaching a reference image in this mode would silently do nothing.
  const canAttach = (canAttachImages || canAttachDocuments) && !imageMode
  const attachmentCount = attachments?.length ?? 0
  const atMaxAttachments = attachmentCount >= maxAttachments
  const readyAttachments = (attachments ?? []).filter((a) => a.status === 'done')
  const hasBusyAttachment = (attachments ?? []).some(
    (a) => a.status === 'uploading' || a.status === 'preparing',
  )

  const accept = [
    canAttachImages && 'image/png,image/jpeg,image/webp',
    canAttachDocuments && 'application/pdf',
  ]
    .filter(Boolean)
    .join(',')

  // Auto-resize up to a max height
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      if (!onAttach || disabled || streaming) return
      const candidates = Array.from(files)
      if (candidates.length === 0) return
      // Deliberately not sliced to the remaining room: the owner enforces the
      // per-message limit and reports the refusal, so a 5th file gets a message
      // instead of vanishing.
      onAttach(candidates)
    },
    [onAttach, disabled, streaming],
  )

  function submit() {
    const trimmed = text.trim()
    if (streaming || disabled) return
    // An image needs words. Attachments cannot stand in for a prompt the way
    // they can for a chat message.
    if (imageMode) {
      if (!trimmed) return
      onSend(trimmed)
      setText('')
      textareaRef.current?.focus()
      return
    }
    if (hasBusyAttachment) return
    if (!trimmed && readyAttachments.length === 0) return
    onSend(trimmed, readyAttachments.map((a) => a.remote!.id))
    setText('')
    textareaRef.current?.focus()
  }

  const attachTitle = !canAttach
    ? 'This model does not support attachments'
    : atMaxAttachments
      ? 'Maximum attachments reached'
      : 'Attach files'

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-3 md:px-4 md:pb-5">
      {attachments && attachments.length > 0 && onRemoveAttachment && (
        <AttachmentTray items={attachments} onRemove={onRemoveAttachment} />
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        // Drop handling lives on the form, not the textarea: the padded ring
        // around it is part of the target the user aims at.
        onDragOver={(e) => {
          if (!canAttach) return
          e.preventDefault()
          e.currentTarget.classList.add('border-accent')
        }}
        onDragLeave={(e) => {
          e.currentTarget.classList.remove('border-accent')
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.currentTarget.classList.remove('border-accent')
          if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files)
        }}
        className={`flex items-end gap-2 rounded-[26px] border bg-surface-2 p-2 shadow-sm ${
          imageMode
            ? 'border-accent focus-within:border-accent'
            : 'border-line focus-within:border-ink-2/40'
        }`}
      >
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={accept}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files)
            e.target.value = ''
          }}
        />

        {/* Attach button */}
        {canAttach && (
          <button
            type="button"
            disabled={disabled || streaming || atMaxAttachments}
            onClick={() => fileInputRef.current?.click()}
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-30"
            title={attachTitle}
            aria-label={attachTitle}
          >
            <Paperclip size={18} />
          </button>
        )}

        {/* Image-generation toggle */}
        {canGenerateImages && onToggleImageMode && (
          <button
            type="button"
            disabled={disabled || streaming}
            onClick={onToggleImageMode}
            aria-pressed={imageMode}
            className={`flex size-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-30 ${
              imageMode
                ? 'bg-accent text-surface'
                : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
            }`}
            // "Generate an image" read as *the* way to get an image, which is
            // wrong: the model also calls generate_image off a plain description
            // in a normal message. The tooltip has room to say so; the
            // aria-label stays short and describes the switch, not exclusivity.
            title={
              imageMode
                ? 'Switch back to chat'
                : 'Image mode — every message generates an image. You can also just describe a picture in a normal message.'
            }
            aria-label={imageMode ? 'Switch back to chat' : 'Switch to image mode'}
          >
            <ImagePlus size={18} />
          </button>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          onPaste={(e) => {
            const files = e.clipboardData.files
            if (files.length > 0) handleFiles(files)
          }}
          rows={1}
          placeholder={imageMode ? 'Describe an image to generate' : 'Message ChatDDB'}
          aria-label={imageMode ? 'Describe an image to generate' : 'Message ChatDDB'}
          className="max-h-[200px] flex-1 resize-none bg-transparent px-2 py-1.5 outline-none placeholder:text-ink-2"
        />
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-surface hover:opacity-80"
            aria-label="Stop generating"
            title="Stop generating"
          >
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={
              imageMode
                ? !text.trim() || disabled
                : (!text.trim() && readyAttachments.length === 0) || disabled || hasBusyAttachment
            }
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-surface transition-opacity hover:opacity-80 disabled:opacity-25"
            aria-label={imageMode ? 'Generate image' : 'Send message'}
            title={imageMode ? 'Generate image' : 'Send message'}
          >
            <ArrowUp size={18} />
          </button>
        )}
      </form>
      <p className="pt-2 text-center text-xs text-ink-2">
        Thank you for believing in LabDDB
      </p>
    </div>
  )
}
