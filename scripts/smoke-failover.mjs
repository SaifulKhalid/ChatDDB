#!/usr/bin/env node

/**
 * End-to-end failover smoke test: does a real `POST /api/chat` survive a dead
 * primary, and does it leave the right trail behind?
 *
 * `scripts/test-failover.mjs` already pins the routing decisions in isolation.
 * This one covers what that cannot — the wiring in `worker/routes/chat.ts`: the
 * response headers, the assistant row's `model_used`/`model_provider`, the
 * `upstream_failover` activity row, and the session title.
 *
 * ## Setup (three terminals)
 *
 * 1. The fake backup gateway, so no metered credit is spent:
 *      npm run stub:gateway
 *
 * 2. The Worker, with the primary pointed at the discard port so it fails as a
 *    network error, and the stub armed as the backup. Vars go on the command
 *    line, so `.dev.vars` is never touched:
 *
 *      npx wrangler dev --port 8788 \
 *        --var AGENTROUTER_BASE_URL:http://127.0.0.1:9/v1 \
 *        --var FREEMODEL_API_KEY:stub-key \
 *        --var FREEMODEL_BASE_URL:http://127.0.0.1:8799/v1
 *
 * 3. This script. `CHATDDB_TOKEN` is a Firebase ID token, from the browser
 *    console of a signed-in tab:  await firebase.auth().currentUser.getIdToken()
 *
 *      BASE_URL=http://127.0.0.1:8788 CHATDDB_TOKEN=<token> npm run smoke:failover
 *
 * ## The other branches worth running
 *
 * - 401 → keys exhausted → cross: restart step 2 with `--var AGENTROUTER_API_KEY:sk-bad`
 *   instead of the base-url override. Expect the same result by a different path.
 * - The kill switch: add `--var FALLBACK_ENABLED:false` and re-run with
 *   `EXPECT_FAILOVER=0`. The request must now fail, proving the switch works.
 * - Both gateways down: also run the stub with `STUB_FAIL=503`, and
 *   `EXPECT_FAILOVER=0`.
 */

import { execFileSync } from 'node:child_process'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8788'
const TOKEN = process.env.CHATDDB_TOKEN
/** Set to 0 when testing the kill switch or a both-gateways-down run. */
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

/** Queries the *local* D1 file that `wrangler dev` writes to. */
function d1(sql) {
  const out = execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'd1', 'execute', DB_NAME, '--local', '--json', '--command', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  // Wrangler prints banner lines before the JSON on some versions.
  const start = out.indexOf('[')
  const parsed = JSON.parse(out.slice(start === -1 ? 0 : start))
  return parsed[0]?.results ?? []
}

async function main() {
  if (!TOKEN) {
    console.error(
      'CHATDDB_TOKEN is required. In a signed-in browser tab:\n' +
        '  await firebase.auth().currentUser.getIdToken()',
    )
    process.exit(2)
  }

  console.log(`Failover smoke test (${BASE})`)
  console.log(`  expecting failover: ${EXPECT_FAILOVER ? 'yes' : 'no'}\n`)

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json())
  console.log('health.ready:', JSON.stringify(health.ready))
  check('health still reports configured', health.configured === true)
  check(
    `health.ready.fallback is ${EXPECT_FAILOVER}`,
    health.ready?.fallback === EXPECT_FAILOVER,
    String(health.ready?.fallback),
  )

  console.log('\nPOST /api/chat')
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ content: 'In one sentence, what is a failover?' }),
  })

  if (!EXPECT_FAILOVER) {
    // Kill switch / both-down run: the old error must surface rather than being
    // silently papered over. Never 502/503 — the frontend reads those as "no
    // backend" and substitutes a mock reply, hiding the failure.
    const body = await res.text()
    check('request fails', res.status >= 400, `got ${res.status}`)
    check('status is not 404/502/503', ![404, 502, 503].includes(res.status), `got ${res.status}`)
    check('no crossover header', res.headers.get('x-chatddb-upstream') === null)
    console.log(`  body: ${body.slice(0, 200)}`)
    return
  }

  check('200 OK', res.status === 200, `got ${res.status} ${await res.clone().text().catch(() => '')}`)
  // The frontend must not be able to tell a crossover happened.
  check(
    'X-ChatDDB-Model is still the requested model',
    res.headers.get('x-chatddb-model') === 'gpt-5.6-sol',
    String(res.headers.get('x-chatddb-model')),
  )
  check(
    'X-ChatDDB-Upstream says freemodel',
    res.headers.get('x-chatddb-upstream') === 'freemodel',
    String(res.headers.get('x-chatddb-upstream')),
  )
  check(
    'X-ChatDDB-Upstream-Model says what really answered',
    res.headers.get('x-chatddb-upstream-model') === 'gpt-5.5',
    String(res.headers.get('x-chatddb-upstream-model')),
  )

  const sessionId = res.headers.get('x-chatddb-session-id')
  check('a session id came back', Boolean(sessionId), String(sessionId))

  const text = await res.text()
  check('the reply actually streamed', text.includes('data:') && text.length > 50, `${text.length} bytes`)
  check('the stream carried no error frame', !text.includes('"type":"error"'), text.slice(0, 200))

  // Persistence runs in waitUntil, after the last frame. Give it a moment.
  await new Promise((r) => setTimeout(r, 1500))

  console.log('\nD1')
  let rows = []
  try {
    rows = d1(
      `SELECT role, model_provider, model_used, token_source, finish_reason, length(message_content) AS chars
         FROM chat_messages WHERE session_id = '${sessionId}' ORDER BY created_at`,
    )
  } catch (err) {
    check('queried chat_messages', false, String(err.message).slice(0, 300))
  }
  console.log(JSON.stringify(rows, null, 2))
  const assistant = rows.find((r) => r.role === 'assistant')
  check('an assistant row was written', Boolean(assistant))
  // The registry says what was requested; the row says what answered.
  check('model_provider records the truth', assistant?.model_provider === 'freemodel', String(assistant?.model_provider))
  check('model_used records the truth', assistant?.model_used === 'gpt-5.5', String(assistant?.model_used))
  check('the reply was stored', (assistant?.chars ?? 0) > 0, String(assistant?.chars))

  let logs = []
  try {
    logs = d1(
      `SELECT action, severity, metadata FROM activity_logs
        WHERE action = 'upstream_failover' ORDER BY timestamp DESC LIMIT 3`,
    )
  } catch (err) {
    check('queried activity_logs', false, String(err.message).slice(0, 300))
  }
  console.log(JSON.stringify(logs, null, 2))
  check('an upstream_failover row exists', logs.length > 0)
  check('logged as a warning', logs[0]?.severity === 'warn', String(logs[0]?.severity))
  check(
    'the metadata names both gateways',
    String(logs[0]?.metadata ?? '').includes('agentrouter') &&
      String(logs[0]?.metadata ?? '').includes('freemodel'),
    String(logs[0]?.metadata),
  )

  // A session named while the primary was down proves the titler failed over too.
  let sessions = []
  try {
    sessions = d1(`SELECT title, model_used FROM chat_sessions WHERE id = '${sessionId}'`)
  } catch {
    /* reported below */
  }
  console.log(JSON.stringify(sessions, null, 2))
  check('the session was still titled', Boolean(sessions[0]?.title), String(sessions[0]?.title))
  // The session's `model_used` tracks the registry id, deliberately unlike the
  // message row: it is what the user picked for this chat.
  check(
    'the session still tracks the requested model',
    sessions[0]?.model_used === 'gpt-5.6-sol',
    String(sessions[0]?.model_used),
  )
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
