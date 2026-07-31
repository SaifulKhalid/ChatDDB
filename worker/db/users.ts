/**
 * The `users` table: upsert on login, admin actions, and stats.
 *
 * `role` and `status` are read from here on every request. They are never
 * carried in a token and never accepted from a client, which is what makes
 * suspension take effect on the suspended user's *next* request rather than
 * whenever their hour-long token happens to expire.
 */

import { all, first, run, scalar } from './client.ts'
import { newId } from '../lib/hash.ts'
import { escapeLike } from '../lib/validate.ts'
import type { VerifiedToken } from '../auth/verify.ts'

export type Role = 'user' | 'admin'
export type Status = 'active' | 'suspended'

export interface UserRow {
  id: string
  firebase_uid: string
  email: string
  name: string | null
  profile_picture: string | null
  role: Role
  status: Status
  created_at: number
  last_login: number | null
  login_count: number
}

/** The shape sent to the client. Deliberately excludes `firebase_uid`. */
export interface PublicUser {
  id: string
  email: string
  name: string | null
  picture: string | null
  role: Role
  status: Status
  createdAt: number
  lastLogin: number | null
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.profile_picture,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastLogin: row.last_login,
  }
}

export function findByFirebaseUid(db: D1Database, uid: string): Promise<UserRow | null> {
  return first<UserRow>(db, `SELECT * FROM users WHERE firebase_uid = ?`, uid)
}

export function findById(db: D1Database, id: string): Promise<UserRow | null> {
  return first<UserRow>(db, `SELECT * FROM users WHERE id = ?`, id)
}

export function findByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return first<UserRow>(db, `SELECT * FROM users WHERE email = ?`, email.toLowerCase())
}

/**
 * Creates or refreshes the user row for a verified token.
 *
 * The match key is `firebase_uid`, not email: emails can change on the Firebase
 * side, and matching on a mutable field would let a changed email silently
 * create a second account (or, worse, collide with someone else's).
 *
 * `adminEmails` promotes listed addresses on every login rather than only at
 * creation, so adding an address to the var and re-logging-in is enough to grant
 * admin -- no SQL needed. It never *demotes*: an admin promoted in the database
 * stays admin if the var is later trimmed, because silently dropping the last
 * admin's access would lock everyone out of the panel.
 */
export async function upsertOnLogin(
  db: D1Database,
  token: VerifiedToken,
  adminEmails: string[],
): Promise<UserRow> {
  const now = Date.now()
  const shouldBeAdmin = adminEmails.some((e) => e.toLowerCase() === token.email)
  const existing = await findByFirebaseUid(db, token.uid)

  if (existing) {
    const role: Role = existing.role === 'admin' || shouldBeAdmin ? 'admin' : 'user'
    await run(
      db,
      `UPDATE users
          SET email = ?, name = ?, profile_picture = ?, role = ?,
              last_login = ?, login_count = login_count + 1
        WHERE id = ?`,
      token.email,
      token.name ?? existing.name,
      token.picture ?? existing.profile_picture,
      role,
      now,
      existing.id,
    )
    return {
      ...existing,
      email: token.email,
      name: token.name ?? existing.name,
      profile_picture: token.picture ?? existing.profile_picture,
      role,
      last_login: now,
      login_count: existing.login_count + 1,
    }
  }

  // First sight of this uid. `idx_users_email` is UNIQUE, so a pre-existing row
  // with the same email but a different uid would collide here -- that means the
  // same person signed in through a different provider, which we surface rather
  // than silently merging two identities.
  const clash = await findByEmail(db, token.email)
  if (clash) {
    await run(
      db,
      `UPDATE users SET firebase_uid = ?, name = ?, profile_picture = ?,
              last_login = ?, login_count = login_count + 1
        WHERE id = ?`,
      token.uid,
      token.name ?? clash.name,
      token.picture ?? clash.profile_picture,
      now,
      clash.id,
    )
    return {
      ...clash,
      firebase_uid: token.uid,
      name: token.name ?? clash.name,
      profile_picture: token.picture ?? clash.profile_picture,
      last_login: now,
      login_count: clash.login_count + 1,
    }
  }

  const row: UserRow = {
    id: newId(),
    firebase_uid: token.uid,
    email: token.email,
    name: token.name ?? null,
    profile_picture: token.picture ?? null,
    role: shouldBeAdmin ? 'admin' : 'user',
    status: 'active',
    created_at: now,
    last_login: now,
    login_count: 1,
  }
  await run(
    db,
    `INSERT INTO users (id, firebase_uid, email, name, profile_picture, role, status,
                        created_at, last_login, login_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.firebase_uid,
    row.email,
    row.name,
    row.profile_picture,
    row.role,
    row.status,
    row.created_at,
    row.last_login,
    row.login_count,
  )
  return row
}

// ---------------------------------------------------------------------------
// Admin actions
// ---------------------------------------------------------------------------

export async function setStatus(db: D1Database, userId: string, status: Status): Promise<void> {
  await run(db, `UPDATE users SET status = ? WHERE id = ?`, status, userId)
}

export async function setRole(db: D1Database, userId: string, role: Role): Promise<void> {
  await run(db, `UPDATE users SET role = ? WHERE id = ?`, role, userId)
}

/** Admins currently in the table -- used to refuse demoting the last one. */
export function countAdmins(db: D1Database): Promise<number> {
  return scalar(db, `SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`)
}

export type UserSort = 'created_at' | 'last_login' | 'email' | 'login_count'

export interface UserListQuery {
  search?: string
  role?: Role
  status?: Status
  sort: UserSort
  direction: 'asc' | 'desc'
  limit: number
  offset: number
}

export interface UserListRow extends UserRow {
  session_count: number
  message_count: number
  file_count: number
}

export interface UserListPage {
  rows: UserListRow[]
  total: number
}

/**
 * The admin user table.
 *
 * `sort` and `direction` index fixed maps rather than being interpolated -- the
 * only way to get text into the SQL string is via a key that already exists in
 * this file.
 */
export async function list(db: D1Database, q: UserListQuery): Promise<UserListPage> {
  const SORT_COLUMNS: Record<UserSort, string> = {
    created_at: 'u.created_at',
    last_login: 'u.last_login',
    email: 'u.email',
    login_count: 'u.login_count',
  }
  const column = SORT_COLUMNS[q.sort] ?? SORT_COLUMNS.created_at
  const direction = q.direction === 'asc' ? 'ASC' : 'DESC'

  const where: string[] = []
  const params: unknown[] = []

  if (q.search) {
    // Bound parameter + escaped LIKE metacharacters: a search for `%` looks for
    // a literal percent sign instead of scanning the whole table.
    where.push(`(u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')`)
    const pattern = `%${escapeLike(q.search)}%`
    params.push(pattern, pattern)
  }
  if (q.role) {
    where.push('u.role = ?')
    params.push(q.role)
  }
  if (q.status) {
    where.push('u.status = ?')
    params.push(q.status)
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  const rows = await all<UserListRow>(
    db,
    `SELECT u.*,
            (SELECT COUNT(*) FROM chat_sessions s WHERE s.user_id = u.id AND s.deleted_at IS NULL) AS session_count,
            (SELECT COUNT(*) FROM chat_messages m WHERE m.user_id = u.id) AS message_count,
            (SELECT COUNT(*) FROM files f WHERE f.user_id = u.id) AS file_count
       FROM users u
       ${clause}
      ORDER BY ${column} ${direction} NULLS LAST
      LIMIT ? OFFSET ?`,
    ...params,
    q.limit,
    q.offset,
  )

  const total = await scalar(db, `SELECT COUNT(*) AS n FROM users u ${clause}`, ...params)
  return { rows, total }
}

export interface PlatformStats {
  totalUsers: number
  activeUsers: number
  suspendedUsers: number
  adminUsers: number
  newUsersToday: number
  totalSessions: number
  totalMessages: number
  messagesToday: number
  totalFiles: number
  storageBytes: number
  /** Distinct users with a message per day, oldest first. */
  dau: { day: number; users: number }[]
}

/**
 * Everything the admin dashboard's cards and sparkline need.
 *
 * One function rather than nine endpoints because each of these is a cheap
 * indexed aggregate and the panel always shows them together -- nine round
 * trips would cost more than the queries do.
 */
export async function platformStats(db: D1Database, dayStartMs: number, days: number): Promise<PlatformStats> {
  const since = dayStartMs - (days - 1) * 86_400_000

  const [
    totalUsers,
    activeUsers,
    suspendedUsers,
    adminUsers,
    newUsersToday,
    totalSessions,
    totalMessages,
    messagesToday,
    totalFiles,
  ] = await Promise.all([
    scalar(db, `SELECT COUNT(*) AS n FROM users`),
    scalar(db, `SELECT COUNT(*) AS n FROM users WHERE status = 'active'`),
    scalar(db, `SELECT COUNT(*) AS n FROM users WHERE status = 'suspended'`),
    scalar(db, `SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`),
    scalar(db, `SELECT COUNT(*) AS n FROM users WHERE created_at >= ?`, dayStartMs),
    scalar(db, `SELECT COUNT(*) AS n FROM chat_sessions WHERE deleted_at IS NULL`),
    scalar(db, `SELECT COUNT(*) AS n FROM chat_messages`),
    scalar(db, `SELECT COUNT(*) AS n FROM chat_messages WHERE created_at >= ?`, dayStartMs),
    scalar(db, `SELECT COUNT(*) AS n FROM files`),
  ])

  const storageBytes = await scalar(
    db,
    `SELECT COALESCE(SUM(file_size), 0) AS n FROM files WHERE upload_status = 'stored'`,
  )

  // Bucket by day in SQL. `created_at` is epoch ms, so integer-dividing by a
  // day and multiplying back gives the UTC midnight each message belongs to --
  // no date functions, no timezone parsing.
  const dau = await all<{ day: number; users: number }>(
    db,
    `SELECT (created_at / 86400000) * 86400000 AS day, COUNT(DISTINCT user_id) AS users
       FROM chat_messages
      WHERE created_at >= ?
      GROUP BY day
      ORDER BY day ASC`,
    since,
  )

  return {
    totalUsers,
    activeUsers,
    suspendedUsers,
    adminUsers,
    newUsersToday,
    totalSessions,
    totalMessages,
    messagesToday,
    totalFiles,
    storageBytes,
    dau,
  }
}

/** Per-user usage summary for `GET /api/me` and the admin drawer. */
export interface UsageSummary {
  sessions: number
  messages: number
  messagesToday: number
  files: number
  storageBytes: number
}

export async function usageFor(db: D1Database, userId: string, dayStartMs: number): Promise<UsageSummary> {
  const [sessions, messages, messagesToday, files, storageBytes] = await Promise.all([
    scalar(db, `SELECT COUNT(*) AS n FROM chat_sessions WHERE user_id = ? AND deleted_at IS NULL`, userId),
    scalar(db, `SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ?`, userId),
    scalar(db, `SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ? AND created_at >= ?`, userId, dayStartMs),
    scalar(db, `SELECT COUNT(*) AS n FROM files WHERE user_id = ?`, userId),
    scalar(
      db,
      `SELECT COALESCE(SUM(file_size), 0) AS n FROM files WHERE user_id = ? AND upload_status = 'stored'`,
      userId,
    ),
  ])
  return { sessions, messages, messagesToday, files, storageBytes }
}
