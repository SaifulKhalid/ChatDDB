/**
 * `files`: upload metadata, ownership, and storage accounting.
 *
 * The R2 object and this row are two writes that must agree. The order is
 * row-first (`upload_status='pending'`), then the R2 put, then the row is
 * promoted to `'stored'`. A crash between them leaves a `pending` row pointing
 * at a key that may or may not exist -- prunable, and never an *untracked*
 * object, which is the failure mode that actually costs money and leaks data.
 */

import { all, first, run, scalar, stmt, type Stmt } from './client.ts'
import { escapeLike } from '../lib/validate.ts'

export type FileType = 'image' | 'pdf'
export type UploadStatus = 'pending' | 'stored' | 'failed'
export type ProcessingStatus = 'none' | 'pending' | 'done' | 'failed' | 'unsupported'
export type ExtractionSource = 'worker' | 'client'
/**
 * Where the bytes came from. `'generated'` is only ever set server-side by
 * `POST /api/images` -- an upload cannot claim it, which is the whole reason the
 * decode happens in the Worker rather than in the browser.
 */
export type FileOrigin = 'upload' | 'generated'

export interface FileRow {
  id: string
  user_id: string
  session_id: string | null
  message_id: string | null
  filename: string
  original_filename: string
  file_type: FileType
  mime_type: string
  file_size: number
  r2_key: string
  sha256: string | null
  upload_status: UploadStatus
  processing_status: ProcessingStatus
  extracted_text_key: string | null
  extracted_text_preview: string | null
  extracted_chars: number | null
  extracted_pages: number | null
  extraction_source: ExtractionSource | null
  origin: FileOrigin
  gen_prompt: string | null
  gen_model: string | null
  created_at: number
}

export interface PublicFile {
  id: string
  filename: string
  type: FileType
  mimeType: string
  size: number
  uploadStatus: UploadStatus
  processingStatus: ProcessingStatus
  extractedChars: number | null
  extractedPages: number | null
  extractionSource: ExtractionSource | null
  /** Drives full-size rendering in the transcript instead of a chip. */
  origin: FileOrigin
  /** Non-null only for `origin: 'generated'`. Shown as the image's caption. */
  genPrompt: string | null
  genModel: string | null
  createdAt: number
}

export function toPublicFile(row: FileRow): PublicFile {
  return {
    id: row.id,
    // The *original* name, for display. React escapes it on render; it is never
    // used to build a filesystem or R2 path -- `filename` is the sanitised one.
    filename: row.original_filename,
    type: row.file_type,
    mimeType: row.mime_type,
    size: row.file_size,
    uploadStatus: row.upload_status,
    processingStatus: row.processing_status,
    extractedChars: row.extracted_chars,
    extractedPages: row.extracted_pages,
    extractionSource: row.extraction_source,
    // Defaulted rather than trusted: rows written before migration 0006 have no
    // value at all when read back from a stale local database.
    origin: row.origin ?? 'upload',
    genPrompt: row.gen_prompt ?? null,
    genModel: row.gen_model ?? null,
    createdAt: row.created_at,
  }
}

export interface CreateFile {
  id: string
  userId: string
  sessionId: string | null
  filename: string
  originalFilename: string
  fileType: FileType
  mimeType: string
  fileSize: number
  r2Key: string
  processingStatus: ProcessingStatus
}

export async function createPending(db: D1Database, input: CreateFile, now = Date.now()): Promise<void> {
  await run(
    db,
    `INSERT INTO files
       (id, user_id, session_id, filename, original_filename, file_type, mime_type,
        file_size, r2_key, upload_status, processing_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    input.id,
    input.userId,
    input.sessionId,
    input.filename,
    input.originalFilename,
    input.fileType,
    input.mimeType,
    input.fileSize,
    input.r2Key,
    input.processingStatus,
    now,
  )
}

export interface CreateGeneratedFile extends CreateFile {
  /** The prompt as the user typed it, already length-checked by the route. */
  genPrompt: string
  /** The Workers AI model id that produced the bytes. */
  genModel: string
}

/**
 * The `createPending` of the image-generation path.
 *
 * Same row-first ordering and the same `'pending'` start, so a crash between
 * this and the R2 put leaves a prunable row rather than an untracked object.
 * `processing_status` is always `'none'`: there is nothing to extract from a
 * JPEG, which is exactly what an uploaded image does too.
 */
export async function createGenerated(
  db: D1Database,
  input: CreateGeneratedFile,
  now = Date.now(),
): Promise<void> {
  await run(
    db,
    `INSERT INTO files
       (id, user_id, session_id, filename, original_filename, file_type, mime_type,
        file_size, r2_key, upload_status, processing_status, origin, gen_prompt,
        gen_model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'none', 'generated', ?, ?, ?)`,
    input.id,
    input.userId,
    input.sessionId,
    input.filename,
    input.originalFilename,
    input.fileType,
    input.mimeType,
    input.fileSize,
    input.r2Key,
    input.genPrompt,
    input.genModel,
    now,
  )
}

export async function markStored(db: D1Database, id: string, sha256: string): Promise<void> {
  await run(db, `UPDATE files SET upload_status = 'stored', sha256 = ? WHERE id = ?`, sha256, id)
}

export async function markFailed(db: D1Database, id: string): Promise<void> {
  await run(db, `UPDATE files SET upload_status = 'failed' WHERE id = ?`, id)
}

export interface ExtractionResult {
  textKey: string | null
  preview: string | null
  chars: number
  pages: number | null
  source: ExtractionSource
  status: ProcessingStatus
}

export async function saveExtraction(db: D1Database, id: string, result: ExtractionResult): Promise<void> {
  await run(
    db,
    `UPDATE files
        SET processing_status = ?, extracted_text_key = ?, extracted_text_preview = ?,
            extracted_chars = ?, extracted_pages = ?, extraction_source = ?
      WHERE id = ?`,
    result.status,
    result.textKey,
    result.preview,
    result.chars,
    result.pages,
    result.source,
    id,
  )
}

export async function markProcessingFailed(db: D1Database, id: string, status: ProcessingStatus): Promise<void> {
  await run(db, `UPDATE files SET processing_status = ? WHERE id = ?`, status, id)
}

/** A file belonging to `userId`, or null. The only lookup on user-facing paths. */
export function getOwned(db: D1Database, id: string, userId: string): Promise<FileRow | null> {
  return first<FileRow>(db, `SELECT * FROM files WHERE id = ? AND user_id = ?`, id, userId)
}

/** Any file by id. Admin paths only, and every call site writes an audit row. */
export function getAny(db: D1Database, id: string): Promise<FileRow | null> {
  return first<FileRow>(db, `SELECT * FROM files WHERE id = ?`, id)
}

/**
 * Fetches several of a user's files at once, for validating a message's
 * attachment list. Ids are bound individually -- the only thing interpolated is
 * the number of `?` placeholders, which comes from `ids.length`.
 */
export async function getManyOwned(db: D1Database, ids: string[], userId: string): Promise<FileRow[]> {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  return all<FileRow>(
    db,
    `SELECT * FROM files WHERE user_id = ? AND id IN (${placeholders})`,
    userId,
    ...ids,
  )
}

/** Links uploaded files to the message that carried them, clearing orphan status. */
export function attachToMessageStmt(ids: string[], messageId: string, sessionId: string, userId: string): Stmt {
  const placeholders = ids.map(() => '?').join(', ')
  return stmt(
    `UPDATE files SET message_id = ?, session_id = ?
      WHERE user_id = ? AND id IN (${placeholders})`,
    messageId,
    sessionId,
    userId,
    ...ids,
  )
}

export async function deleteOwned(db: D1Database, id: string, userId: string): Promise<boolean> {
  const res = await run(db, `DELETE FROM files WHERE id = ? AND user_id = ?`, id, userId)
  return (res.meta.changes ?? 0) > 0
}

export function listForUser(db: D1Database, userId: string, limit: number): Promise<FileRow[]> {
  return all<FileRow>(
    db,
    `SELECT * FROM files WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    userId,
    limit,
  )
}

export function listForMessage(db: D1Database, messageId: string): Promise<FileRow[]> {
  return all<FileRow>(db, `SELECT * FROM files WHERE message_id = ? ORDER BY created_at ASC`, messageId)
}

/** Attachments for a whole transcript in one query, grouped by the caller. */
export function listForSession(db: D1Database, sessionId: string): Promise<FileRow[]> {
  return all<FileRow>(
    db,
    `SELECT * FROM files WHERE session_id = ? AND message_id IS NOT NULL ORDER BY created_at ASC`,
    sessionId,
  )
}

/**
 * Files uploaded but never attached to a message, older than `cutoff`.
 *
 * Someone attaches a file, changes their mind, and closes the tab: the object is
 * in R2 and paid for, and no message references it. `npm run db:prune` deletes
 * these. Not a scheduled job -- the Free plan gives cron 10 ms of CPU.
 */
export function findOrphans(db: D1Database, cutoff: number, limit: number): Promise<FileRow[]> {
  return all<FileRow>(
    db,
    `SELECT * FROM files
      WHERE message_id IS NULL AND created_at < ?
      ORDER BY created_at ASC
      LIMIT ?`,
    cutoff,
    limit,
  )
}

export async function deleteById(db: D1Database, id: string): Promise<void> {
  await run(db, `DELETE FROM files WHERE id = ?`, id)
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface AdminFileRow extends FileRow {
  email: string | null
  name: string | null
}

export async function adminList(
  db: D1Database,
  opts: {
    search?: string
    userId?: string
    type?: FileType
    processing?: ProcessingStatus
    limit: number
    offset: number
  },
): Promise<{ rows: AdminFileRow[]; total: number }> {
  const where: string[] = []
  const params: unknown[] = []

  if (opts.userId) {
    where.push('f.user_id = ?')
    params.push(opts.userId)
  }
  if (opts.type) {
    where.push('f.file_type = ?')
    params.push(opts.type)
  }
  if (opts.processing) {
    where.push('f.processing_status = ?')
    params.push(opts.processing)
  }
  if (opts.search) {
    where.push(`(f.original_filename LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')`)
    const pattern = `%${escapeLike(opts.search)}%`
    params.push(pattern, pattern)
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  const rows = await all<AdminFileRow>(
    db,
    `SELECT f.*, u.email, u.name
       FROM files f
       LEFT JOIN users u ON u.id = f.user_id
       ${clause}
      ORDER BY f.created_at DESC
      LIMIT ? OFFSET ?`,
    ...params,
    opts.limit,
    opts.offset,
  )
  const total = await scalar(
    db,
    `SELECT COUNT(*) AS n FROM files f LEFT JOIN users u ON u.id = f.user_id ${clause}`,
    ...params,
  )
  return { rows, total }
}

export interface StorageStats {
  totalFiles: number
  totalBytes: number
  images: number
  pdfs: number
  pendingProcessing: number
  failedProcessing: number
  orphans: number
  topUsers: { userId: string; email: string | null; files: number; bytes: number }[]
}

export async function storageStats(db: D1Database, orphanCutoff: number): Promise<StorageStats> {
  const [totalFiles, totalBytes, images, pdfs, pendingProcessing, failedProcessing, orphans] =
    await Promise.all([
      scalar(db, `SELECT COUNT(*) AS n FROM files`),
      scalar(db, `SELECT COALESCE(SUM(file_size), 0) AS n FROM files WHERE upload_status = 'stored'`),
      scalar(db, `SELECT COUNT(*) AS n FROM files WHERE file_type = 'image'`),
      scalar(db, `SELECT COUNT(*) AS n FROM files WHERE file_type = 'pdf'`),
      scalar(db, `SELECT COUNT(*) AS n FROM files WHERE processing_status = 'pending'`),
      scalar(db, `SELECT COUNT(*) AS n FROM files WHERE processing_status = 'failed'`),
      scalar(db, `SELECT COUNT(*) AS n FROM files WHERE message_id IS NULL AND created_at < ?`, orphanCutoff),
    ])

  const topUsers = await all<{ userId: string; email: string | null; files: number; bytes: number }>(
    db,
    `SELECT f.user_id AS userId, u.email, COUNT(*) AS files, COALESCE(SUM(f.file_size), 0) AS bytes
       FROM files f
       LEFT JOIN users u ON u.id = f.user_id
      GROUP BY f.user_id
      ORDER BY bytes DESC
      LIMIT 10`,
  )

  return { totalFiles, totalBytes, images, pdfs, pendingProcessing, failedProcessing, orphans, topUsers }
}
