/**
 * Rate limiting on D1 counters.
 *
 * ## Why not the `ratelimits` binding
 *
 * Cloudflare's native rate-limit binding is GA, but its counters are per-colo
 * and its period is fixed at 10 or 60 seconds. "300 messages per day per user"
 * is expressible in neither, and a per-colo daily quota is not a quota.
 *
 * ## Why absolute buckets
 *
 * Workers pin `Date.now()` between I/O, so a value read at the top of a request
 * can equal one read later even though real time passed. Any scheme that asks
 * "how long ago did this window open?" is therefore unreliable inside a Worker.
 * Flooring the clock into a bucket -- `floor(now / period) * period` -- is not:
 * it needs one clock read and gives the same answer however stale that read is.
 * This bit us once on stream pacing already.
 *
 * ## Cost
 *
 * One D1 write per limited request, against a Free-tier 100k rows/day budget.
 * Affordable, not free -- `sample` exists for the high-frequency actions.
 */

import { batch, first, run, stmt } from '../db/client.ts'
import { rateLimited } from './http.ts'

export type RateAction = 'chat' | 'upload' | 'auth' | 'admin' | 'image'
export type WindowKind = 'minute' | 'day'

const PERIOD_MS: Record<WindowKind, number> = {
  minute: 60_000,
  day: 86_400_000,
}

export interface Limit {
  kind: WindowKind
  max: number
}

export interface RateVerdict {
  allowed: boolean
  /** Seconds until the offending window rolls over. */
  retryAfter: number
  /** Which window tripped, for the log row. */
  kind?: WindowKind
  limit?: number
  count?: number
}

function windowStart(now: number, kind: WindowKind): number {
  return Math.floor(now / PERIOD_MS[kind]) * PERIOD_MS[kind]
}

/**
 * Increments the counters for `subject` and reports whether the request may
 * proceed.
 *
 * Counts first, then compares. A request that trips the limit is still counted,
 * which is intentional: a client hammering a limited endpoint should not be able
 * to keep its own counter low by being refused.
 *
 * `max: 0` disables a window (set the env var to 0), so limits can be turned off
 * in development without a code path for "no limiter".
 */
export async function consume(
  db: D1Database,
  subject: string,
  action: RateAction,
  limits: Limit[],
  now = Date.now(),
): Promise<RateVerdict> {
  const active = limits.filter((l) => l.max > 0)
  if (active.length === 0) return { allowed: true, retryAfter: 0 }

  // UPSERT so the first request in a window creates the row and later ones bump
  // it, in one statement -- no read-then-write race between concurrent requests.
  await batch(
    db,
    active.map((l) =>
      stmt(
        `INSERT INTO rate_counters (subject, window_kind, action, window_start, count)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT (subject, window_kind, action, window_start)
         DO UPDATE SET count = count + 1`,
        subject,
        l.kind,
        action,
        windowStart(now, l.kind),
      ),
    ),
  )

  for (const l of active) {
    const start = windowStart(now, l.kind)
    const row = await first<{ count: number }>(
      db,
      `SELECT count FROM rate_counters
        WHERE subject = ? AND window_kind = ? AND action = ? AND window_start = ?`,
      subject,
      l.kind,
      action,
      start,
    )
    const count = row?.count ?? 0
    if (count > l.max) {
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((start + PERIOD_MS[l.kind] - now) / 1000)),
        kind: l.kind,
        limit: l.max,
        count,
      }
    }
  }
  return { allowed: true, retryAfter: 0 }
}

/** Human wording for a 429 body, distinguishing a burst from a daily quota. */
export function limitMessage(verdict: RateVerdict, noun: string): string {
  if (verdict.kind === 'day') {
    return `You have reached today's limit of ${verdict.limit} ${noun}. It resets at midnight UTC.`
  }
  const seconds = verdict.retryAfter
  return `Too many ${noun} in a short time. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`
}

/** Throws the 429 for a tripped verdict. */
export function enforce(verdict: RateVerdict, noun: string): void {
  if (!verdict.allowed) throw rateLimited(limitMessage(verdict, noun), verdict.retryAfter)
}

/** Reads a counter without incrementing it -- for `/api/me` quota display. */
export async function peek(
  db: D1Database,
  subject: string,
  action: RateAction,
  kind: WindowKind,
  now = Date.now(),
): Promise<number> {
  const row = await first<{ count: number }>(
    db,
    `SELECT count FROM rate_counters
      WHERE subject = ? AND window_kind = ? AND action = ? AND window_start = ?`,
    subject,
    kind,
    action,
    windowStart(now, kind),
  )
  return row?.count ?? 0
}

/**
 * Drops buckets that can no longer be consulted.
 *
 * Anything older than one day plus a margin is dead: the minute windows expired
 * long ago and the day window has rolled. Called by `npm run db:prune`.
 */
export async function pruneExpired(db: D1Database, now = Date.now()): Promise<number> {
  const cutoff = windowStart(now, 'day') - PERIOD_MS.day
  const res = await run(db, `DELETE FROM rate_counters WHERE window_start < ?`, cutoff)
  return res.meta.changes ?? 0
}
