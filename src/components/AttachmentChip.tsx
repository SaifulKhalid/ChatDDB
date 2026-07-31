/**
 * A single attachment chip shown in the composer tray or on a sent message.
 *
 * Four visual states: preparing (spinner), uploading (progress bar), done
 * (thumbnail / icon with filename and size), and failed (red border + message).
 */

import { useEffect, useState } from 'react'
import { FileText, ImageIcon, Loader2, Paperclip, X } from 'lucide-react'
import type { PublicFile } from '../lib/apiTypes'
import { useSignedImageUrl } from '../lib/fileUrl'

export interface PendingAttachment {
  localId: string
  file: File
  status: 'preparing' | 'uploading' | 'done' | 'failed'
  progress: number
  error?: string
  remote?: PublicFile
  controller?: AbortController
}

export function AttachmentChip({
  item,
  onRemove,
  compact,
}: {
  item: PendingAttachment
  onRemove?: () => void
  /** For message attachments (read-only, no remove button). */
  compact?: boolean
}) {
  return (
    <div
      className={`relative flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
        item.status === 'failed'
          ? 'border-red-500/50 bg-red-500/5'
          : 'border-line bg-surface-2'
      } ${compact ? 'max-w-48' : ''}`}
    >
      {/* Preview / icon */}
      <Thumbnail file={item.file} remote={item.remote} />

      {/* Info */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-ink">
          {item.remote?.filename ?? item.file.name}
        </p>
        <p className="text-[11px] text-ink-2">
          {item.status === 'preparing' && 'Preparing…'}
          {item.status === 'uploading' && `${Math.round(item.progress * 100)}%`}
          {item.status === 'done' && subtitle(item.remote, item.file)}
          {item.status === 'failed' && (item.error ?? 'Upload failed')}
        </p>
      </div>

      {/* Remove button */}
      {!compact && onRemove && (
        <button
          onClick={onRemove}
          className="shrink-0 rounded-lg p-1 text-ink-2 hover:bg-surface-3 hover:text-ink"
          aria-label={`Remove ${item.file.name}`}
        >
          <X size={14} />
        </button>
      )}

      {/* Progress bar */}
      {item.status === 'uploading' && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden rounded-b-xl bg-surface-3">
          <div
            className="h-full rounded-b-xl bg-accent transition-all duration-200"
            style={{ width: `${item.progress * 100}%` }}
          />
        </div>
      )}
    </div>
  )
}

/**
 * Size, plus what the server managed to make of a PDF.
 *
 * A scanned PDF uploads fine but yields no text, and the user needs to know that
 * before wondering why the model ignored it.
 */
function subtitle(remote: PublicFile | undefined, file: File): string {
  const size = formatSize(remote?.size ?? file.size)
  if (remote?.type !== 'pdf') return size
  if (remote.processingStatus === 'done') {
    const pages = remote.extractedPages
    return pages ? `${size} · ${pages} page${pages !== 1 ? 's' : ''}` : size
  }
  if (remote.processingStatus === 'pending') return `${size} · extracting text…`
  return `${size} · text not extracted`
}

function Thumbnail({ file, remote }: { file: File; remote?: PublicFile }) {
  // `file.type` is empty for attachments rehydrated from a transcript, where the
  // placeholder File carries no bytes — `remote.type` is the authority then.
  const isImage = remote ? remote.type === 'image' : file.type.startsWith('image/')
  const isPdf = remote ? remote.type === 'pdf' : file.type === 'application/pdf'

  const remoteId = remote?.id
  // After upload: a short-lived signed URL, because `<img>` cannot send an
  // Authorization header. The expiry re-mint lives in the hook.
  const signed = useSignedImageUrl(remoteId, isImage)
  // Before upload: the local bytes, which need no network round-trip.
  const [localSrc, setLocalSrc] = useState<string | null>(null)

  useEffect(() => {
    if (!isImage || remoteId || file.size === 0) {
      setLocalSrc(null)
      return
    }
    const url = URL.createObjectURL(file)
    setLocalSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [file, remoteId, isImage])

  const src = remoteId ? signed.src : localSrc
  const broken = remoteId ? signed.broken : false

  if (isImage) {
    return (
      <div className="size-9 shrink-0 overflow-hidden rounded-lg bg-surface-3">
        {src && !broken ? (
          <img src={src} alt="" onError={signed.onError} className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center text-ink-2">
            {broken || !remoteId ? <ImageIcon size={16} /> : <Loader2 size={14} className="animate-spin" />}
          </div>
        )}
      </div>
    )
  }

  if (isPdf) {
    return (
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-500">
        <FileText size={16} />
      </div>
    )
  }

  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-ink-2">
      <Paperclip size={14} />
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Wraps a stored file as a chip item so sent messages can reuse this component.
 *
 * The `File` is a zero-byte stand-in: everything rendered comes from `remote`.
 */
export function chipFromPublicFile(remote: PublicFile): PendingAttachment {
  return {
    localId: remote.id,
    file: new File([], remote.filename, { type: remote.mimeType }),
    status: 'done',
    progress: 1,
    remote,
  }
}
