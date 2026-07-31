/**
 * Activity log writes and queries.
 *
 * The action vocabulary is a union type declared here, once. The admin filter
 * dropdown and every writer both import it, so a typo is a compile error rather
 * than a row that no filter will ever match.
 */

import { all, first, run, scalar, stmt, type Stmt } from './client.ts'
import { newId } from '../lib/hash.ts'

export const ACTIVITY_ACTIONS = [
  'login',
  'logout',
  'login_denied_suspended',
  'chat_started',
  'message_sent',
  'model_selected',
  'file_uploaded',
  'file_deleted',
  'file_processed',
  'rate_limited',
  'suspicious_activity',
  /**
   * The primary gateway failed and the metered backup answered instead. The
   * user saw nothing, which is the point — this row is the only durable record
   * that money was spent, and the signal that AgentRouter is having a bad day.
   */
  'upstream_failover',
  /**
   * An image was generated on Workers AI. Worth its own row rather than folding
   * into `message_sent`: the free neuron allowance is per *account* and shared
   * by every user, so "who is spending it" is a question only these rows answer.
   */
  'image_generated',
  /** Generation was attempted but the model or the allowance refused it. */
  'image_failed',
  'admin_chat_access',
  'admin_file_access',
  'admin_user_updated',
  'admin_login',
] as const

export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number]

export type Severity = 'info' | 'warn' | 'alert'

export interface ActivityRow {
  id: string
  user_id: string | null
  action: string
  metadata: string | null
  ip_hash: string | null
  user_agent: string | null
  severity: string
  timestamp: number
}

export interface ActivityInput {
  userId?: string | null
  action: ActivityAction
  /** Ids and counts only -- never message content, filenames, or emails. */
  metadata?: Record<string, unknown>
  ipHash?: string
  userAgent?: string | null
  severity?: Severity
}

/** User agents are truncated; the full string is a weak fingerprint. */
const MAX_UA_CHARS = 256
/** Cap on serialised metadata, so one odd row cannot bloat the table. */
const MAX_METADATA_CHARS = 2_000

function buildRow(input: ActivityInput): Stmt {
  let metadata: string | null = null
  if (input.metadata && Object.keys(input.metadata).length > 0) {
    try {
      metadata = JSON.stringify(input.metadata).slice(0, MAX_METADATA_CHARS)
    } catch {
      metadata = null
    }
  }
  return stmt(
    `INSERT INTO activity_logs (id, user_id, action, metadata, ip_hash, user_agent, severity, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(),
    input.userId ?? null,
    input.action,
    metadata,
    input.ipHash ?? null,
    input.userAgent?.slice(0, MAX_UA_CHARS) ?? null,
    input.severity ?? 'info',
    Date.now(),
  )
}

/** A statement for the caller to include in its own batch. */
export function logStmt(input: ActivityInput): Stmt {
  return buildRow(input)
}

/**
 * Writes one log row.
 *
 * Never throws: an audit write failing must not take down the request that
 * triggered it. The failure is logged to the Worker console, which is where an
 * operator would look for "why is the feed empty?".
 *
 * Where a log accompanies another write, prefer `logStmt` in the same
 * `batch()` -- that way the log and the action it describes land atomically.
 */
export async function log(db: D1Database | undefined, input: ActivityInput): Promise<void> {
  if (!db) return
  const row = buildRow(input)
  try {
    await run(db, row.sql, ...row.params)
  } catch (err) {
    console.error('[chatddb] activity log failed (%s): %s', input.action, err instanceof Error ? err.message : err)
  }
}

export interface ActivityQuery {
  userId?: string
  action?: ActivityAction
  severity?: Severity
  from?: number
  to?: number
  limit: number
  offset: number
}

export interface ActivityPage {
  rows: (ActivityRow & { email: string | null; name: string | null })[]
  total: number
}

/**
 * The admin activity feed.
 *
 * Filters are appended as bound parameters -- the SQL text itself is assembled
 * only from fixed fragments chosen by the code, never from request values.
 */
export async function query(db: D1Database, q: ActivityQuery): Promise<ActivityPage> {
  const where: string[] = []
  const params: unknown[] = []

  if (q.userId) {
    where.push('a.user_id = ?')
    params.push(q.userId)
  }
  if (q.action) {
    where.push('a.action = ?')
    params.push(q.action)
  }
  if (q.severity) {
    where.push('a.severity = ?')
    params.push(q.severity)
  }
  if (q.from !== undefined) {
    where.push('a.timestamp >= ?')
    params.push(q.from)
  }
  if (q.to !== undefined) {
    where.push('a.timestamp <= ?')
    params.push(q.to)
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  const rows = await all<ActivityRow & { email: string | null; name: string | null }>(
    db,
    `SELECT a.*, u.email, u.name
       FROM activity_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ${clause}
      ORDER BY a.timestamp DESC
      LIMIT ? OFFSET ?`,
    ...params,
    q.limit,
    q.offset,
  )

  const total = await scalar(db, `SELECT COUNT(*) AS n FROM activity_logs a ${clause}`, ...params)
  return { rows, total }
}

/** Counts per action over a window, for the admin dashboard. */
export async function actionCounts(db: D1Database, since: number): Promise<{ action: string; n: number }[]> {
  return all<{ action: string; n: number }>(
    db,
    `SELECT action, COUNT(*) AS n
       FROM activity_logs
      WHERE timestamp >= ?
      GROUP BY action
      ORDER BY n DESC`,
    since,
  )
}

/** Most recent rows for one user, for the admin user drawer. */
export async function recentForUser(db: D1Database, userId: string, limit: number): Promise<ActivityRow[]> {
  return all<ActivityRow>(
    db,
    `SELECT * FROM activity_logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?`,
    userId,
    limit,
  )
}

/**
 * How many times `action` has been logged for a subject since `since`.
 * Used by the suspicious-activity heuristics.
 */
export async function countSince(
  db: D1Database,
  userId: string,
  action: ActivityAction,
  since: number,
): Promise<number> {
  return scalar(
    db,
    `SELECT COUNT(*) AS n FROM activity_logs WHERE user_id = ? AND action = ? AND timestamp >= ?`,
    userId,
    action,
    since,
  )
}

/** Distinct IP hashes seen for a user since `since` -- a shared-account signal. */
export async function distinctIpsSince(db: D1Database, userId: string, since: number): Promise<number> {
  return scalar(
    db,
    `SELECT COUNT(DISTINCT ip_hash) AS n
       FROM activity_logs
      WHERE user_id = ? AND timestamp >= ? AND ip_hash IS NOT NULL`,
    userId,
    since,
  )
}

/** Retention pruning. Operator-invoked (`npm run db:prune`), never an API route. */
export async function pruneOlderThan(db: D1Database, cutoff: number): Promise<number> {
  const res = await run(db, `DELETE FROM activity_logs WHERE timestamp < ?`, cutoff)
  return res.meta.changes ?? 0
}

/** The single oldest row's timestamp, so `db:prune` can report what it saw. */
export async function oldestTimestamp(db: D1Database): Promise<number | null> {
  const row = await first<{ ts: number | null }>(db, `SELECT MIN(timestamp) AS ts FROM activity_logs`)
  return row?.ts ?? null
}
