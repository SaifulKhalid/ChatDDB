/**
 * `chat_sessions`: CRUD, ownership, and the counters the sidebar reads.
 *
 * Ownership is always a WHERE clause. `getOwned(db, id, userId)` returns null
 * for someone else's session rather than returning the row for a caller to
 * check, so forgetting the check is not possible.
 *
 * ## Soft delete
 *
 * Deleting a chat sets `deleted_at`. It vanishes from the user's UI immediately
 * and every user-facing query filters it out, but an abuse investigation still
 * has the record. This is disclosed in PRIVACY.md rather than hidden -- a
 * "delete" that is really a hide has to be stated.
 */

import { all, batch, first, run, scalar, stmt } from './client.ts'
import { newId } from '../lib/hash.ts'
import { escapeLike } from '../lib/validate.ts'

/**
 * Where a title came from -- see migration 0005.
 *
 * `placeholder` is ours and still up for grabs, `auto` is the model's and may be
 * replaced by a later auto pass, `manual` is the user's and is never touched
 * again. The old test for "up for grabs" was `title = 'New chat'`, which broke
 * as soon as a session was created with a derived title.
 */
export type TitleSource = 'placeholder' | 'auto' | 'manual'

export interface SessionRow {
  id: string
  user_id: string
  title: string
  title_source: TitleSource
  model_used: string | null
  message_count: number
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export interface PublicSession {
  id: string
  title: string
  titleSource: TitleSource
  model: string | null
  messageCount: number
  createdAt: number
  updatedAt: number
}

export function toPublicSession(row: SessionRow): PublicSession {
  return {
    id: row.id,
    title: row.title,
    titleSource: row.title_source,
    model: row.model_used,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Longest a generated title may be before it is trimmed back to a word break. */
const TITLE_MAX_CHARS = 48
/** Words to keep. Matches the 3-8 word target the model is asked for. */
const TITLE_MAX_WORDS = 8

/**
 * Best-effort title from the user's own first message.
 *
 * This is the fallback, not the main event: a session is named properly by the
 * model after the first exchange completes (see `generateTitle` in
 * `../provider.ts`). But the sidebar row exists the moment the request
 * arrives, so it needs something better than "New chat" to show meanwhile.
 *
 * The old version sliced the first 40 characters of the first line, which put
 * fenced-code fences, markdown headings, and half-words in the sidebar. This
 * skips lines that carry no prose, strips the leading markup, and cuts on a word
 * boundary. It deliberately does not shorten meaning -- picking *which* words
 * matter is the model's job, not a regex's.
 */
export function makeTitle(text: string): string {
  const line = firstProseLine(text)
  if (!line) return 'New chat'

  const words = line.split(/\s+/).slice(0, TITLE_MAX_WORDS)
  let title = words.join(' ')
  if (title.length > TITLE_MAX_CHARS) {
    const cut = title.slice(0, TITLE_MAX_CHARS)
    const lastSpace = cut.lastIndexOf(' ')
    // Only honour the word break if it leaves a usable amount of text; a very
    // long first word (a URL, an identifier) is better cut mid-way than dropped.
    title = `${lastSpace > TITLE_MAX_CHARS / 2 ? cut.slice(0, lastSpace) : cut}…`
  } else if (words.length === TITLE_MAX_WORDS && line.split(/\s+/).length > TITLE_MAX_WORDS) {
    title = `${title}…`
  }
  return title || 'New chat'
}

/**
 * First line of `text` that reads as prose, with markdown leaders removed.
 *
 * Fenced blocks are skipped wholesale rather than line-by-line: their contents
 * can look like anything, including like prose.
 */
function firstProseLine(text: string): string {
  let inFence = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || !line) continue

    const stripped = line
      // Headings, quotes, list markers, checkboxes -- structure, not content.
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s*/, '')
      .replace(/^([*+-]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s*/, '')
      // Inline emphasis and code marks around the words we are keeping.
      .replace(/[*_`~]/g, '')
      .trim()
    if (stripped) return stripped
  }
  return ''
}

/**
 * Creates a session.
 *
 * `titleSource` is written explicitly rather than left to the column default.
 * Migration 0005 defaults it to 'manual' because that is the safe direction for
 * rows that already existed, so a new session that relied on the default would
 * be born frozen and never auto-named.
 */
export async function create(
  db: D1Database,
  userId: string,
  title: string,
  model: string | null,
  titleSource: TitleSource = 'placeholder',
  id = newId(),
  now = Date.now(),
): Promise<SessionRow> {
  const row: SessionRow = {
    id,
    user_id: userId,
    title,
    title_source: titleSource,
    model_used: model,
    message_count: 0,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  }
  await run(
    db,
    `INSERT INTO chat_sessions (id, user_id, title, title_source, model_used, message_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    row.id,
    row.user_id,
    row.title,
    row.title_source,
    row.model_used,
    row.created_at,
    row.updated_at,
  )
  return row
}

/** A live session belonging to `userId`, or null. Never returns another's row. */
export function getOwned(db: D1Database, id: string, userId: string): Promise<SessionRow | null> {
  return first<SessionRow>(
    db,
    `SELECT * FROM chat_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    id,
    userId,
  )
}

/** Any session by id, including soft-deleted. Admin paths only. */
export function getAny(db: D1Database, id: string): Promise<SessionRow | null> {
  return first<SessionRow>(db, `SELECT * FROM chat_sessions WHERE id = ?`, id)
}

export interface SessionPage {
  rows: SessionRow[]
  total: number
}

export async function listForUser(
  db: D1Database,
  userId: string,
  limit: number,
  offset: number,
): Promise<SessionPage> {
  const rows = await all<SessionRow>(
    db,
    `SELECT * FROM chat_sessions
      WHERE user_id = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?`,
    userId,
    limit,
    offset,
  )
  const total = await scalar(
    db,
    `SELECT COUNT(*) AS n FROM chat_sessions WHERE user_id = ? AND deleted_at IS NULL`,
    userId,
  )
  return { rows, total }
}

/**
 * Renames a session on the user's instruction, and freezes the name.
 *
 * `title_source = 'manual'` is set here rather than in the route because this is
 * the only statement that writes a user-chosen title -- the route is pure
 * delegation. Freezing is permanent and one-way: once someone has named a chat
 * themselves, no later auto pass gets to overrule them, even if they rename it
 * back to 'New chat'.
 */
export async function rename(db: D1Database, id: string, userId: string, title: string): Promise<boolean> {
  const res = await run(
    db,
    `UPDATE chat_sessions SET title = ?, title_source = 'manual', updated_at = ?
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    title,
    Date.now(),
    id,
    userId,
  )
  return (res.meta.changes ?? 0) > 0
}

export async function softDelete(db: D1Database, id: string, userId: string): Promise<boolean> {
  const res = await run(
    db,
    `UPDATE chat_sessions SET deleted_at = ?
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    Date.now(),
    id,
    userId,
  )
  return (res.meta.changes ?? 0) > 0
}

/**
 * Statement that bumps a session's counters.
 *
 * Returned as a statement rather than executed so the caller can put it in the
 * same `batch()` as the message insert -- D1 batches are transactional, which is
 * what keeps `message_count` from drifting away from the actual row count.
 */
export function touchStmt(id: string, addMessages: number, model: string | null, now = Date.now()) {
  return stmt(
    `UPDATE chat_sessions
        SET message_count = message_count + ?,
            updated_at = ?,
            model_used = COALESCE(?, model_used)
      WHERE id = ?`,
    addMessages,
    now,
    model,
    id,
  )
}

/**
 * Statement that applies a model-generated title, unless the user owns the name.
 *
 * The guard is `title_source <> 'manual'`, so it covers both cases that matter:
 * a placeholder we wrote, and an earlier auto title that a better one may
 * replace. The old guard compared the title text to 'New chat', which missed
 * every session whose placeholder was derived from the first message, and would
 * have clobbered a user who renamed a chat to that exact string.
 *
 * Returned as a statement so the caller can batch it with the message insert --
 * same reason as `touchStmt`.
 */
export function retitleStmt(id: string, title: string) {
  return stmt(
    `UPDATE chat_sessions SET title = ?, title_source = 'auto'
      WHERE id = ? AND title_source <> 'manual'`,
    title,
    id,
  )
}

// ---------------------------------------------------------------------------
// Import of pre-Phase-2 localStorage history
// ---------------------------------------------------------------------------

export interface ImportSession {
  title: string
  createdAt: number
  updatedAt: number
  messages: { role: 'user' | 'assistant'; content: string; createdAt: number }[]
}

/**
 * Bulk-inserts conversations a user had in `localStorage` before Phase 2.
 *
 * Every row gets a **server-generated id** and the caller's `userId`; ids and
 * user ids from the client blob are discarded. Otherwise an import body could
 * claim to be someone else's session or collide with a real one.
 *
 * `model_used` is null and messages carry no token counts: these turns were
 * generated before any of that was recorded, and inventing numbers would
 * pollute the admin totals.
 */
export async function importSessions(
  db: D1Database,
  userId: string,
  incoming: ImportSession[],
): Promise<{ sessions: number; messages: number }> {
  const statements = []
  let messageTotal = 0

  for (const session of incoming) {
    const sessionId = newId()
    statements.push(
      stmt(
        `INSERT INTO chat_sessions (id, user_id, title, title_source, model_used, message_count, created_at, updated_at)
         VALUES (?, ?, ?, 'manual', NULL, ?, ?, ?)`,
        sessionId,
        userId,
        session.title,
        session.messages.length,
        session.createdAt,
        session.updatedAt,
      ),
    )
    for (const message of session.messages) {
      statements.push(
        stmt(
          `INSERT INTO chat_messages (id, session_id, user_id, role, message_content, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          newId(),
          sessionId,
          userId,
          message.role,
          message.content,
          message.createdAt,
        ),
      )
      messageTotal++
    }
  }

  // D1 caps statements per batch, so chunk. Each chunk is its own transaction:
  // a failure part-way leaves earlier chunks imported, which is why the client
  // marks the local blob as imported rather than deleting it.
  const CHUNK = 50
  for (let i = 0; i < statements.length; i += CHUNK) {
    await batch(db, statements.slice(i, i + CHUNK))
  }
  return { sessions: incoming.length, messages: messageTotal }
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface AdminSessionRow extends SessionRow {
  email: string | null
  name: string | null
}

/**
 * Cross-user session search for the admin chat inspector.
 *
 * Searches titles only, not message bodies. Full-text search over everyone's
 * messages is a far broader privacy surface than the spec asks for, and D1 has
 * no FTS index here -- it would be a table scan on the largest table.
 */
export async function adminSearch(
  db: D1Database,
  opts: { search?: string; userId?: string; includeDeleted: boolean; limit: number; offset: number },
): Promise<{ rows: AdminSessionRow[]; total: number }> {
  const where: string[] = []
  const params: unknown[] = []

  if (!opts.includeDeleted) where.push('s.deleted_at IS NULL')
  if (opts.userId) {
    where.push('s.user_id = ?')
    params.push(opts.userId)
  }
  if (opts.search) {
    where.push(`(s.title LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')`)
    const pattern = `%${escapeLike(opts.search)}%`
    params.push(pattern, pattern)
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  const rows = await all<AdminSessionRow>(
    db,
    `SELECT s.*, u.email, u.name
       FROM chat_sessions s
       LEFT JOIN users u ON u.id = s.user_id
       ${clause}
      ORDER BY s.updated_at DESC
      LIMIT ? OFFSET ?`,
    ...params,
    opts.limit,
    opts.offset,
  )
  const total = await scalar(
    db,
    `SELECT COUNT(*) AS n FROM chat_sessions s LEFT JOIN users u ON u.id = s.user_id ${clause}`,
    ...params,
  )
  return { rows, total }
}

export function listForUserAdmin(db: D1Database, userId: string, limit: number): Promise<SessionRow[]> {
  return all<SessionRow>(
    db,
    `SELECT * FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`,
    userId,
    limit,
  )
}
