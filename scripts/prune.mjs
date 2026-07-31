#!/usr/bin/env node

/**
 * Database pruning script.
 *
 * Deletes, in order:
 *   1. activity_logs rows older than ACTIVITY_RETENTION_DAYS (default 90)
 *   2. rate_counters buckets older than 2 days
 *   3. files that never made it onto a message, older than 24h → prints their
 *      R2 keys so they can be removed with `wrangler r2 object delete`
 *   4. chat_sessions soft-deleted more than 30 days ago, and their messages
 *
 * Usage:
 *   node scripts/prune.mjs            # local (default)
 *   node scripts/prune.mjs --remote   # deployed
 *   node scripts/prune.mjs --dry      # SELECT COUNT(*) only
 *   node scripts/prune.mjs --remote --dry
 */

import { execSync } from 'node:child_process'

const RETENTION_DAYS = Number(process.env.ACTIVITY_RETENTION_DAYS ?? 90)
const NOW = Date.now()
const DAY_MS = 86_400_000

const isRemote = process.argv.includes('--remote')
const isDry = process.argv.includes('--dry')

const flag = isRemote ? '--remote' : '--local'
const prefix = isRemote ? '(remote)' : '(local)'

const DB = 'chatddb-f5-db'
const BUCKET = 'chatddb-f5-storage'

const ACTIVITY_CUTOFF = NOW - RETENTION_DAYS * DAY_MS
const COUNTER_CUTOFF = NOW - 2 * DAY_MS
const ORPHAN_CUTOFF = NOW - DAY_MS
const SESSION_CUTOFF = NOW - 30 * DAY_MS

/**
 * `--json` is not optional: without it wrangler prints a human table and the
 * `JSON.parse` below throws into the catch, which used to make every step look
 * like a query error.
 */
function cmd(sql) {
  const quoted = sql
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/\s+/g, ' ')
    .trim()
  // `npx` because wrangler is a devDependency and is not on PATH globally.
  return `npx wrangler d1 execute ${DB} ${flag} --json --command "${quoted}"`
}

function exec(sql) {
  const out = execSync(cmd(sql), { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  // Wrangler may still emit an update notice on stdout ahead of the payload.
  const start = out.search(/[[{]/)
  if (start < 0) throw new Error(`no JSON in wrangler output: ${out.slice(0, 200)}`)
  const parsed = JSON.parse(out.slice(start))
  const first = Array.isArray(parsed) ? parsed[0] : parsed
  return { results: first?.results ?? [], changes: first?.meta?.changes ?? null }
}

const steps = [
  {
    name: 'activity_logs',
    // Table is `activity_logs` and its time column is `timestamp` — see
    // migrations/0001. (§6.2 of the pseudocode says `activity_log`/`created_at`;
    // that prose does not match the schema it ships with.)
    count: `SELECT COUNT(*) AS cnt FROM activity_logs WHERE timestamp < ${ACTIVITY_CUTOFF}`,
    run: `DELETE FROM activity_logs WHERE timestamp < ${ACTIVITY_CUTOFF}`,
  },
  {
    name: 'rate_counters',
    // `window_start`, not `window` — which is also an SQLite reserved word.
    count: `SELECT COUNT(*) AS cnt FROM rate_counters WHERE window_start < ${COUNTER_CUTOFF}`,
    run: `DELETE FROM rate_counters WHERE window_start < ${COUNTER_CUTOFF}`,
  },
  {
    name: 'files (orphaned >24h)',
    // The worker's own definition of an orphan is `message_id IS NULL`
    // (worker/db/files.ts findOrphans, and the `orphans` admin stat). A stalled
    // `upload_status='pending'` row is junk too, so both are swept here.
    count: `SELECT COUNT(*) AS cnt FROM files
              WHERE created_at < ${ORPHAN_CUTOFF}
                AND (message_id IS NULL OR upload_status = 'pending')`,
    select: `SELECT id, r2_key, extracted_text_key FROM files
               WHERE created_at < ${ORPHAN_CUTOFF}
                 AND (message_id IS NULL OR upload_status = 'pending')`,
    after: (rows) => {
      const ids = rows.map((r) => r.id)
      if (ids.length === 0) return
      const list = ids.map((id) => `'${id}'`).join(',')
      const { changes } = exec(`DELETE FROM files WHERE id IN (${list})`)
      console.log(`  → ${changes ?? ids.length} rows deleted`)

      // R2 has no transactional link to D1, so the objects are listed rather
      // than deleted: a wrong bucket name here would be unrecoverable.
      const keys = rows.flatMap((r) => [r.r2_key, r.extracted_text_key].filter(Boolean))
      if (keys.length > 0) {
        console.log(`${prefix} R2 objects to remove (${keys.length}):`)
        for (const k of keys) {
          console.log(`  npx wrangler r2 object delete ${BUCKET}/${k}${isRemote ? '' : ' --local'}`)
        }
      }
    },
  },
  {
    name: 'chat_sessions (soft-deleted >30d)',
    count: `SELECT COUNT(*) AS cnt FROM chat_sessions
              WHERE deleted_at IS NOT NULL AND deleted_at < ${SESSION_CUTOFF}`,
    select: `SELECT id FROM chat_sessions
               WHERE deleted_at IS NOT NULL AND deleted_at < ${SESSION_CUTOFF}`,
    after: (rows) => {
      const ids = rows.map((r) => r.id)
      if (ids.length === 0) return
      const list = ids.map((id) => `'${id}'`).join(',')
      // Explicit, in order: `d1 execute` does not enable PRAGMA foreign_keys,
      // so the ON DELETE CASCADE in migration 0002 will not fire here.
      const msgs = exec(`DELETE FROM chat_messages WHERE session_id IN (${list})`)
      const sess = exec(`DELETE FROM chat_sessions WHERE id IN (${list})`)
      console.log(`  → ${msgs.changes ?? '?'} messages, ${sess.changes ?? ids.length} sessions deleted`)
    },
  },
]

function main() {
  let failed = 0

  for (const step of steps) {
    console.log(`${prefix} ${isDry ? 'count' : 'prune'} ${step.name}…`)
    try {
      if (isDry) {
        const { results } = exec(step.count)
        console.log(`  → ${results[0]?.cnt ?? 0} rows`)
        continue
      }
      if (step.select) {
        const { results } = exec(step.select)
        console.log(`  → ${results.length} matched`)
        step.after(results)
      } else {
        const { changes } = exec(step.run)
        console.log(`  → ${changes ?? '?'} rows deleted`)
      }
    } catch (err) {
      failed++
      console.error(`  error: ${err.stderr?.toString().slice(0, 300) ?? err.message}`)
    }
  }

  if (isDry) {
    console.log(`\n${prefix} Dry run — nothing changed. Run without --dry to execute.`)
  }
  if (failed > 0) {
    console.error(`\n${failed} step(s) failed.`)
    process.exit(1)
  }
}

main()
