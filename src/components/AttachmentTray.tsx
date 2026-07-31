import type { PendingAttachment } from './AttachmentChip'
import { AttachmentChip } from './AttachmentChip'

export function AttachmentTray({
  items,
  onRemove,
}: {
  items: PendingAttachment[]
  onRemove: (localId: string) => void
}) {
  if (items.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 border-b border-line px-3 py-2">
      {items.map((it) => (
        <AttachmentChip key={it.localId} item={it} onRemove={() => onRemove(it.localId)} />
      ))}
    </div>
  )
}
