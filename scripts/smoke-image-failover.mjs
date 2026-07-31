#!/usr/bin/env node

/**
 * End-to-end image failover smoke test: does `POST /api/images` survive a dead
 * Workers AI, and does the crossover leave the right trail behind?
 *
 * The sibling of `scripts/smoke-failover.mjs`, which does the same job for the
 * chat gateways. It covers what a unit test cannot: that `generateAndStore`
 * writes the `image_failover` row, that `files.gen_model` records the provider
 * that actually drew the image rather than the one that was asked first, and
 * that `limitImage` still gates the backup path.
 *
 * It also drives the *other* direction. Every branch of `classifyPollinations`
 * is asserted here, because that function is the one place in Task 1 that could
 * not be written from Workers AI's error vocabulary — Pollinations shares none of
 * it, and a mapping that quietly falls through to `image_failed` would look
 * exactly like a working one from the outside.
 *
 * ## Setup (three terminals)
 *
 * 1. The fake Pollinations endpoint, so no metered allowance is spent:
 *      npm run stub:pollinations
 *
 * 2. The Worker, with Workers AI pointed at a model that does not exist — the
 *    binding answers "No such model", which `classifyWorkersAi` maps to
 *    `image_model_unavailable`, one of the two crossable types. Vars go on the
 *    command line, so `.dev.vars` is never touched:
 *
 *      npx wrangler dev --port 8788 \
 *        --var IMAGE_MODEL:@cf/nonexistent/no-such-model \
 *        --var POLLINATIONS_API_KEY:stub-key \
 *        --var POLLINATIONS_BASE_URL:http://127.0.0.1:8798
 *
 * 3. This script, with a Firebase ID token from a signed-in browser tab:
 *      await firebase.auth().currentUser.getIdToken()
 *
 *      BASE_URL=http://127.0.0.1:8788 CHATDDB_TOKEN=<token> npm run smoke:image-failover
 *
 * ## How the failure cases are driven
 *
 * Each classification case sends a prompt containing a `[stub:MODE]` marker,
 * which `stub-pollinations.mjs` reads to decide how to answer that one request.
 * The prompt is the only field a caller can push all the way through to the
 * provider, so it is the only channel available — and it means all five branches
 * run against one Worker and one stub, instead of five restarts of each.
 *
 * ## The other branch worth running
 *
 * The kill switch. Re-run step 2 with `--var POLLINATIONS_ENABLED:false` and set
 * `EXPECT_FAILOVER=0`. The crossover must stop happening and the original
 * Workers AI error must surface — a backup that cannot be switched off is not a
 * backup, it is a dependency.
 */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8788'
const TOKEN = process.env.CHATDDB_TOKEN
/** Set to 0 when testing the `POLLINATIONS_ENABLED=false` kill switch. */
const EXPECT_FAILOVER = process.env.EXPECT_FAILOVER !== '0'
const DB_NAME = 'chatddb-f5-db'

let passed = 0
let failed = 0

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

/**
 * Queries the *local* D1 file that `wrangler dev` writes to.
 *
 * Spawned as `node <literal path to wrangler.js>` rather than the obvious `npx
 * wrangler`, because neither obvious form works here. Node 22 on Windows
 * refuses to `execFileSync` a `.cmd` shim at all (EINVAL), and the `shell: true`
 * escape hatch re-splits the SQL on spaces, so wrangler sees `SELECT` followed
 * by a pile of unknown arguments. Passing the script to `process.execPath`
 * sidesteps both: no shim, no shell, argv preserved. `require.resolve` cannot
 * find it either — wrangler's `exports` map does not publish `./bin/wrangler.js`
 * — hence the hard-coded path.
 */
function d1(sql) {
  const out = execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
      ...['d1', 'execute', DB_NAME, '--local', '--json', '--command', sql],
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const start = out.indexOf('[')
  const parsed = JSON.parse(out.slice(start === -1 ? 0 : start))
  return parsed[0]?.results ?? []
}

const headers = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${TOKEN}`,
})

async function generate(prompt, sessionId) {
  const res = await fetch(`${BASE}/api/images`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(sessionId ? { prompt, sessionId } : { prompt }),
  })
  const body = await res.json().catch(() => null)
  return { res, body }
}

/**
 * Asserts one `classifyPollinations` branch.
 *
 * The type is what is checked, not the prose: `error.type` is what the frontend
 * and every future caller branch on, and it is the thing a mis-ordered classifier
 * gets wrong while still producing a plausible-looking message.
 */
async function classifies(mode, expectedType, expectedStatus) {
  const { res, body } = await generate(`a red bicycle [stub:${mode}]`)
  const type = body?.error?.type ?? '(none)'
  check(
    `stub ${mode} → ${expectedType} (${expectedStatus})`,
    type === expectedType && res.status === expectedStatus,
    `got ${res.status} ${type}: ${String(body?.error?.message ?? '').slice(0, 120)}`,
  )
}

async function main() {
  if (!TOKEN) {
    console.error(
      'CHATDDB_TOKEN is required. In a signed-in browser tab:\n' +
        '  await firebase.auth().currentUser.getIdToken()',
    )
    process.exit(2)
  }

  console.log(`Image failover smoke test (${BASE})`)
  console.log(`  expecting failover: ${EXPECT_FAILOVER ? 'yes' : 'no'}\n`)

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json())
  console.log('health.ready:', JSON.stringify(health.ready))
  check('health.ready.image is true', health.ready?.image === true, String(health.ready?.image))
  check(
    `health.ready.imageFallback is ${EXPECT_FAILOVER}`,
    health.ready?.imageFallback === EXPECT_FAILOVER,
    String(health.ready?.imageFallback),
  )
  if (EXPECT_FAILOVER) {
    check(
      'health names the backup provider',
      health.imageFallbackProvider === 'pollinations',
      String(health.imageFallbackProvider),
    )
    // The "armed vs merely enabled" distinction. A key-less deployment with the
    // switch left on must say so here rather than reporting a backup it has no
    // credential for.
    check(
      'no unconfigured-fallback warning while the key is present',
      !(health.missing ?? []).some((m) => m.includes('POLLINATIONS_API_KEY')),
      JSON.stringify(health.missing),
    )
  }

  if (!EXPECT_FAILOVER) {
    // Kill-switch run: the primary's own failure must surface, unchanged.
    console.log('\nPOST /api/images (kill switch armed)')
    const { res, body } = await generate('a red bicycle on a white background')
    check('the request fails', res.status >= 400, `got ${res.status}`)
    check(
      'the Workers AI error surfaces, not a backup one',
      body?.error?.type === 'image_model_unavailable' &&
        !String(body?.error?.message ?? '').toLowerCase().includes('backup'),
      `${body?.error?.type}: ${body?.error?.message}`,
    )
    const rows = d1(
      `SELECT COUNT(*) AS n FROM activity_logs WHERE action = 'image_failover'
         AND timestamp > ${Date.now() - 60_000}`,
    )
    check('no crossover was attempted', Number(rows[0]?.n ?? 0) === 0, JSON.stringify(rows))
    return
  }

  // ---- The crossover succeeds ---------------------------------------------
  console.log('\nPOST /api/images — Workers AI dead, Pollinations serving')
  const since = Date.now()
  const { res, body } = await generate('a red bicycle on a white background [stub:ok]')
  check('201 Created', res.status === 201, `got ${res.status} ${JSON.stringify(body?.error ?? {})}`)

  const file = body?.file
  const sessionId = body?.sessionId
  check('a generated file came back', file?.origin === 'generated', String(file?.origin))
  check('the file is stored', file?.uploadStatus === 'stored', String(file?.uploadStatus))
  // The stub serves a 1x1 JPEG; the sniffer, not the stub's header, decides this.
  check('the bytes were sniffed as JPEG', file?.mimeType === 'image/jpeg', String(file?.mimeType))
  // The whole point of the `gen_model` prefix: `flux` alone would be
  // indistinguishable from the Cloudflare model of the same family.
  check(
    'gen_model records the provider that actually drew it',
    file?.genModel === 'pollinations/flux',
    String(file?.genModel),
  )

  // Persistence of the activity row runs in waitUntil, after the response.
  await new Promise((r) => setTimeout(r, 1000))

  console.log('\nD1')
  const files = d1(`SELECT gen_model, origin, upload_status, mime_type FROM files WHERE id = '${file?.id}'`)
  console.log(JSON.stringify(files, null, 2))
  check('the stored row agrees with the response', files[0]?.gen_model === 'pollinations/flux', JSON.stringify(files[0]))

  const logs = d1(
    `SELECT action, severity, metadata FROM activity_logs
      WHERE action = 'image_failover' AND timestamp >= ${since} ORDER BY timestamp DESC LIMIT 3`,
  )
  console.log(JSON.stringify(logs, null, 2))
  check('an image_failover row exists', logs.length > 0)
  check('logged as a warning', logs[0]?.severity === 'warn', String(logs[0]?.severity))
  check(
    'the metadata names both providers and the reason',
    String(logs[0]?.metadata ?? '').includes('workers-ai') &&
      String(logs[0]?.metadata ?? '').includes('pollinations') &&
      String(logs[0]?.metadata ?? '').includes('image_model_unavailable'),
    String(logs[0]?.metadata),
  )

  // The gate is not skipped just because a different provider served. Asserted
  // through the counter rather than by exhausting it: a run that burned the
  // user's whole daily image budget could not be repeated the same day.
  const limits = d1(
    `SELECT action, window_kind, count FROM rate_counters
      WHERE subject LIKE 'user:%' AND action = 'image' ORDER BY window_start DESC LIMIT 2`,
  )
  console.log(JSON.stringify(limits, null, 2))
  check('limitImage still consumed a slot on the backup path', limits.length > 0, JSON.stringify(limits))

  // ---- The crossover fails, in each documented way -------------------------
  //
  // Both providers are now broken, so what the user sees is entirely down to
  // `classifyPollinations`. A generic `image_failed` here is the exact failure
  // this section exists to catch.
  console.log('\nPollinations-side failures → classified, not generic')
  await classifies('quota', 'image_quota_exhausted', 429)
  await classifies('model', 'image_model_unavailable', 500)
  await classifies('refused', 'image_prompt_refused', 400)
  await classifies('down', 'image_model_unavailable', 500)
  // A 200 whose body is JSON. Must be caught by the content-type check rather
  // than stored as if the envelope were a picture.
  await classifies('json200', 'image_failed', 502)

  // A refusal is an answer. Nothing crosses over *from* Pollinations — it is last
  // on the chain — but the reverse must hold too, and that is checked by the
  // count: the five cases above may each log at most the one Workers AI
  // crossover that got them to Pollinations in the first place.
  const crossings = d1(
    `SELECT COUNT(*) AS n FROM activity_logs
      WHERE action = 'image_failover' AND timestamp >= ${since}`,
  )
  check(
    'each attempt crossed over exactly once',
    Number(crossings[0]?.n ?? 0) === 6,
    `${crossings[0]?.n} rows for 6 attempts`,
  )

  // Clean up: the session cascades to its messages, and the file row with it.
  if (sessionId) {
    await fetch(`${BASE}/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` },
    }).catch(() => {})
  }
}

main()
  .catch((err) => {
    console.error(`\nfatal: ${err.message}`)
    failed++
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
  })
