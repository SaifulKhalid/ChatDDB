/**
 * Scheduled cleanup of stale guest accounts and their R2 storage.
 *
 * Guests are ephemeral: if they have not signed in for GUEST_RETENTION_DAYS (default 30),
 * their R2 files are deleted first, then their user row is deleted.
 *
 * Foreign key cascades on `users(id)` automatically clean up:
 *   - chat_sessions
 *   - chat_messages
 *   - files
 *
 * activity_logs uses `ON DELETE SET NULL`, preserving the historical audit trail.
 */

import { all, run } from '../db/client.ts'

export interface CleanupResult {
  expiredGuests: number
  deletedFiles: number
}

interface GuestFileRef {
  id: string
  r2_key: string
  extracted_text_key: string | null
}

export async function cleanupExpiredGuests(
  db: D1Database,
  bucket: R2Bucket | undefined,
  retentionDays: number,
  now = Date.now(),
): Promise<CleanupResult> {
  const cutoff = now - retentionDays * 86_400_000

  // Find all guests whose last activity was before the retention cutoff
  const guests = await all<{ id: string }>(
    db,
    `SELECT id FROM users
      WHERE is_guest = 1
        AND (last_login < ? OR (last_login IS NULL AND created_at < ?))`,
    cutoff,
    cutoff,
  )

  if (guests.length === 0) {
    return { expiredGuests: 0, deletedFiles: 0 }
  }

  let totalFilesDeleted = 0

  for (const guest of guests) {
    // 1. Find all R2 keys belonging to this guest
    const files = await all<GuestFileRef>(
      db,
      `SELECT id, r2_key, extracted_text_key FROM files WHERE user_id = ?`,
      guest.id,
    )

    // 2. Delete R2 objects first
    if (bucket && files.length > 0) {
      for (const file of files) {
        if (file.r2_key) {
          await bucket.delete(file.r2_key).catch((err) => {
            console.warn('[chatddb] failed to delete R2 object %s: %s', file.r2_key, err)
          })
        }
        if (file.extracted_text_key) {
          await bucket.delete(file.extracted_text_key).catch((err) => {
            console.warn('[chatddb] failed to delete R2 object %s: %s', file.extracted_text_key, err)
          })
        }
      }
    }
    totalFilesDeleted += files.length

    // 3. Delete the user row -- cascades to chat_sessions, chat_messages, files.
    // activity_logs set user_id to NULL, keeping the audit trail.
    await run(db, `DELETE FROM users WHERE id = ?`, guest.id)
  }

  console.log(
    '[chatddb] guest cleanup: deleted %d guest user(s) and %d file(s) older than %d days',
    guests.length,
    totalFilesDeleted,
    retentionDays,
  )

  return {
    expiredGuests: guests.length,
    deletedFiles: totalFilesDeleted,
  }
}
