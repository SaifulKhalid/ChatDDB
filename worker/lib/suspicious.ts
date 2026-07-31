/**
 * Suspicious-activity heuristics.
 *
 * These flag *abuse patterns*, not topics. Nothing here looks at what a user is
 * asking about -- only at rates, repetition, and rejected attempts. Content
 * moderation is explicitly out of scope (PHASE2-PLAN.md §7).
 *
 * Every check runs after the request it describes has already been answered
 * (via `waitUntil`), so a heuristic can never slow down or block a legitimate
 * request. The output is an `activity_logs` row with `severity` and evidence in
 * `metadata`; acting on it is a human decision, not an automatic ban.
 */

import * as activity from '../db/activity.ts'
import type { Severity } from '../db/activity.ts'

const MINUTE = 60_000
const HOUR = 3_600_000

/** Thresholds. Deliberately loose -- a false alert costs an admin's attention. */
const THRESHOLDS = {
  /** Rate-limit trips in an hour before it stops looking like an accident. */
  rateTripsPerHour: 5,
  /** Identical prompts in ten minutes -- a loop or a scripted client. */
  repeatedPromptsPer10Min: 6,
  /** Rejected uploads in an hour -- probing what the validator accepts. */
  rejectedUploadsPerHour: 8,
  /** Distinct IP hashes in an hour -- a shared or resold account. */
  distinctIpsPerHour: 6,
} as const

export interface FlagInput {
  db: D1Database
  userId: string
  ipHash: string | undefined
  userAgent: string | null
}

async function flag(
  input: FlagInput,
  reason: string,
  severity: Severity,
  evidence: Record<string, unknown>,
): Promise<void> {
  await activity.log(input.db, {
    userId: input.userId,
    action: 'suspicious_activity',
    severity,
    metadata: { reason, ...evidence },
    ipHash: input.ipHash,
    userAgent: input.userAgent,
  })
}

/**
 * Called after a rate limit trips.
 *
 * One trip is a user typing fast. Five in an hour is a script, so the second
 * signal escalates to `alert` while the first stays as the ordinary
 * `rate_limited` row the limiter already wrote.
 */
export async function afterRateLimit(input: FlagInput, action: string): Promise<void> {
  const trips = await activity.countSince(input.db, input.userId, 'rate_limited', Date.now() - HOUR)
  if (trips >= THRESHOLDS.rateTripsPerHour) {
    await flag(input, 'repeated_rate_limit', 'alert', { action, tripsLastHour: trips })
  }
}

/**
 * Called after a message is accepted.
 *
 * Checks two things: an unusual number of distinct IP hashes for one account,
 * and the same prompt sent over and over. The prompt check compares a *hash* of
 * the text, not the text -- the log never gains message content.
 */
export async function afterMessage(input: FlagInput, promptHash: string): Promise<void> {
  const since = Date.now() - 10 * MINUTE
  const repeats = await countRepeatedPrompts(input.db, input.userId, promptHash, since)
  if (repeats >= THRESHOLDS.repeatedPromptsPer10Min) {
    await flag(input, 'repeated_identical_prompt', 'warn', { repeats, promptHash })
  }

  const ips = await activity.distinctIpsSince(input.db, input.userId, Date.now() - HOUR)
  if (ips >= THRESHOLDS.distinctIpsPerHour) {
    await flag(input, 'many_distinct_ips', 'warn', { distinctIpHashes: ips })
  }
}

/** Called after an upload is refused by validation. */
export async function afterRejectedUpload(input: FlagInput, why: string): Promise<void> {
  const since = Date.now() - HOUR
  const rejects = await countRejectedUploads(input.db, input.userId, since)
  if (rejects >= THRESHOLDS.rejectedUploadsPerHour) {
    await flag(input, 'upload_probing', 'alert', { rejectionsLastHour: rejects, lastReason: why })
  }
}

/**
 * Counts recent messages whose prompt hash matches.
 *
 * Reads `metadata` with a LIKE against the JSON text. That is a little crude,
 * but it avoids a second table for what is a heuristic, and `promptHash` is a
 * fixed-length hex string this module produced -- there is no user text in the
 * pattern. The `user_id`/`timestamp` index bounds the scan.
 */
async function countRepeatedPrompts(
  db: D1Database,
  userId: string,
  promptHash: string,
  since: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM activity_logs
        WHERE user_id = ? AND action = 'message_sent' AND timestamp >= ?
          AND metadata LIKE ?`,
    )
    .bind(userId, since, `%"promptHash":"${promptHash}"%`)
    .first<{ n: number }>()
  return row?.n ?? 0
}

async function countRejectedUploads(db: D1Database, userId: string, since: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM activity_logs
        WHERE user_id = ? AND action = 'suspicious_activity' AND timestamp >= ?
          AND metadata LIKE '%"reason":"upload_rejected"%'`,
    )
    .bind(userId, since)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/** Records a single rejected upload, which `afterRejectedUpload` then counts. */
export async function noteRejectedUpload(
  input: FlagInput,
  why: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await flag(input, 'upload_rejected', 'info', { why, ...detail })
}

/** Records repeated failed authentication from one IP hash (no user id yet). */
export async function noteAuthFailure(
  db: D1Database | undefined,
  ipHash: string | undefined,
  userAgent: string | null,
  why: string,
): Promise<void> {
  await activity.log(db, {
    userId: null,
    action: 'suspicious_activity',
    severity: 'info',
    metadata: { reason: 'auth_failure', why },
    ipHash,
    userAgent,
  })
}
