import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, ImagePlus, Paperclip, Square } from 'lucide-react'
import type { PendingAttachment } from './AttachmentChip'
import type { ModelSpec } from '../lib/apiTypes'
import { AttachmentTray } from './AttachmentTray'
import { ModelPicker } from './ModelPicker'

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
  /** The registry. The picker is hidden below two entries — nothing to choose. */
  models?: ModelSpec[]
  /** `null` is Auto. */
  model?: string | null
  onModelChange?: (modelId: string | null) => void
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
  models,
  model = null,
  onModelChange,
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

  // Auto-focus on mount and when streaming ends
  useEffect(() => {
    if (!disabled && !streaming) textareaRef.current?.focus()
  }, [disabled, streaming])

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
    ? 'This AI service does not support attachments'
    : atMaxAttachments
      ? 'Maximum attachments reached'
      : 'Attach files'

  return (
    <div className="composer-wrap mx-auto w-full max-w-3xl px-3 pb-3 md:px-4">
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
        className={`flex flex-col rounded-[24px] border bg-surface-2 p-1.5 shadow-sm transition-colors ${
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
          className="min-h-[44px] max-h-[200px] w-full resize-none bg-transparent px-3 pt-2 pb-1 text-sm text-ink outline-none placeholder:text-ink-2"
        />

        {/* Bottom controls row */}
        <div className="flex items-center justify-between gap-1.5 px-1.5 pb-1 pt-0.5">
          {/* Left: Attach & Image generation toggle */}
          <div className="flex items-center gap-1">
            {canAttach && (
              <button
                type="button"
                disabled={disabled || streaming || atMaxAttachments}
                onClick={() => fileInputRef.current?.click()}
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-30"
                title={attachTitle}
                aria-label={attachTitle}
              >
                <Paperclip size={17} />
              </button>
            )}

            {canGenerateImages && onToggleImageMode && (
              <button
                type="button"
                disabled={disabled || streaming}
                onClick={onToggleImageMode}
                aria-pressed={imageMode}
                className={`flex size-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-30 ${
                  imageMode
                    ? 'bg-accent text-surface'
                    : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
                }`}
                title={
                  imageMode
                    ? 'Switch back to chat'
                    : 'Image mode — every message generates an image. You can also just describe a picture in a normal message.'
                }
                aria-label={imageMode ? 'Switch back to chat' : 'Switch to image mode'}
              >
                <ImagePlus size={17} />
              </button>
            )}
          </div>

          {/* Right: AI Service Picker + Send/Stop button */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            {models && models.length > 1 && onModelChange && (
              <ModelPicker
                models={models}
                value={model}
                onChange={onModelChange}
                disabled={disabled || imageMode}
                disabledReason={
                  imageMode
                    ? 'Image mode does not use an AI service — switch back to chat to pick one.'
                    : undefined
                }
              />
            )}

            {streaming ? (
              <button
                type="button"
                onClick={onStop}
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-surface hover:opacity-80 active:scale-95"
                aria-label="Stop generating"
                title="Stop generating"
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={
                  imageMode
                    ? !text.trim() || disabled
                    : (!text.trim() && readyAttachments.length === 0) || disabled || hasBusyAttachment
                }
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-surface transition-all hover:opacity-80 active:scale-95 disabled:opacity-25"
                aria-label={imageMode ? 'Generate image' : 'Send message'}
                title={imageMode ? 'Generate image' : 'Send message'}
              >
                <ArrowUp size={17} />
              </button>
            )}
          </div>
        </div>
      </form>
      <p className="pt-2 text-center text-xs text-ink-2">
        Thank you for believing in LabDDB
      </p>
    </div>
  )
}
