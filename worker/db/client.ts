/**
 * D1 access helpers.
 *
 * Every function in `db/*` takes its `D1Database` as an argument rather than
 * reading a global env, which matches the existing `resolveConfig(env)` style
 * and keeps the services testable with a stub.
 *
 * Two rules hold throughout `db/`:
 *  1. **Always bound parameters.** No SQL is ever built by string concatenation,
 *     including in admin search -- see `escapeLike` in `lib/validate.ts`.
 *  2. **Ownership is a WHERE clause, not a post-fetch check.** Queries filter by
 *     `user_id` in SQL so a wrong id returns no rows instead of returning rows
 *     that then need guarding.
 */

import { notConfigured, serverError } from '../lib/http.ts'

/** Narrows the optional binding, with an actionable message when it is absent. */
export function requireDb(db: D1Database | undefined): D1Database {
  if (!db) {
    throw notConfigured(
      'The database is not bound. Add the `DB` d1_databases binding to wrangler.jsonc ' +
        'and run `npm run db:migrate:local`.',
    )
  }
  return db
}

export function requireBucket(bucket: R2Bucket | undefined): R2Bucket {
  if (!bucket) {
    throw notConfigured(
      'File storage is not bound. Add the `FILES` r2_buckets binding to wrangler.jsonc.',
    )
  }
  return bucket
}

/**
 * Wraps a D1 call so a driver failure surfaces as a 500 with a stable type
 * instead of leaking SQL text (which can contain user data) to the client.
 * The real error still reaches the Worker logs.
 */
async function guard<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    console.error('[chatddb] d1 %s failed: %s', label, err instanceof Error ? err.message : String(err))
    throw serverError('A database operation failed.', 'database_error')
  }
}

export function first<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return guard('first', async () => db.prepare(sql).bind(...params).first<T>())
}

export function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  return guard('all', async () => {
    const res = await db.prepare(sql).bind(...params).all<T>()
    return res.results ?? []
  })
}

export function run(db: D1Database, sql: string, ...params: unknown[]): Promise<D1Result> {
  return guard('run', async () => db.prepare(sql).bind(...params).run())
}

/** Reads a single aggregate value, e.g. `SELECT COUNT(*) AS n ...`. */
export async function scalar(db: D1Database, sql: string, ...params: unknown[]): Promise<number> {
  const row = await first<{ n: number | null }>(db, sql, ...params)
  return row?.n ?? 0
}

export interface Stmt {
  sql: string
  params: unknown[]
}

export const stmt = (sql: string, ...params: unknown[]): Stmt => ({ sql, params })

/**
 * Runs statements as one D1 batch.
 *
 * D1's `batch` is atomic -- it wraps the statements in a transaction, so a
 * message insert and its session counter bump either both land or neither does.
 * That is why counters can be denormalised without drifting.
 */
export function batch(db: D1Database, statements: Stmt[]): Promise<D1Result[]> {
  if (statements.length === 0) return Promise.resolve([])
  return guard('batch', async () =>
    db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.params))),
  )
}

/** True when D1 answers a trivial query -- used by `/api/health`. */
export async function dbReady(db: D1Database | undefined): Promise<boolean> {
  if (!db) return false
  try {
    await db.prepare('SELECT 1').first()
    return true
  } catch {
    return false
  }
}

/**
 * True when the R2 binding answers.
 *
 * A `list({limit: 1})` is a class-A operation, so this is cheap but not free;
 * `/api/health` is not on a hot path. `head` on a known-absent key would be
 * cheaper but cannot distinguish "bucket missing" from "key missing".
 */
export async function bucketReady(bucket: R2Bucket | undefined): Promise<boolean> {
  if (!bucket) return false
  try {
    await bucket.list({ limit: 1 })
    return true
  } catch {
    return false
  }
}
