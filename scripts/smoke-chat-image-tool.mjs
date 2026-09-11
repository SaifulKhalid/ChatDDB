#!/usr/bin/env node

/**
 * End-to-end smoke test for the `generate_image` tool: does the model reach for
 * it mid-conversation, does the image land on the assistant turn, and do the
 * budgets actually stop it?
 *
 * The tool path shares almost everything with `POST /api/images` — the same
 * provider chain, the same `generateAndStore`, the same `limitImage` gate. What
 * it does *not* share is where the decision comes from, and that is what this
 * script is for: the three cases below are the ones where a passing unit test
 * would still leave the feature broken.
 *
 * ## This one spends money, twice over
 *
 * Unlike the other smoke scripts, every case here runs a real completion through
 * AgentRouter, and case 1 also draws a real image on the account's shared
 * Workers AI allowance (~58 neurons, about 0.6% of a day). Case 1 additionally
 * spends one of the user's `RATE_TOOL_IMAGE_PER_DAY` slots, which defaults to 5
 * — so a handful of runs in one day will start failing case 1 for real reasons.
 * Case 3 exhausts that budget deliberately, which is why it runs last.
 *
 * Set SKIP_GENERATE=1 to run only cases 2 and 3, which never reach a provider.
 *
 * ## Setup
 *
 *   npx wrangler dev --port 8787
 *   CHATDDB_TOKEN=<id-token> npm run smoke:chat-image-tool
 *
 * Get a token from the browser console of a signed-in tab:
 *   await firebase.auth().currentUser.getIdToken()
 *
 * ## Why the prompt is a two-turn conversation
 *
 * The interesting case is not "draw me a cat" — that is a command, and any model
 * would route it. It is a user who has been talking about something and then asks
 * to *see* it, with no imperative verb and no mention of an image. That is what
 * `TOOL_USE_CLAUSE` is written for and what phase 1 of `scripts/probe-tool-calling.mjs`
 * measured at 5/5, so it is what is asserted here.
 */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE_URL ?? 'http://localhost:8787'
const TOKEN = process.env.CHATDDB_TOKEN
const SKIP_GENERATE = process.env.SKIP_GENERATE === '1'
const DB_NAME = 'chatddb-f5-db'

if (!TOKEN) {
  console.error(
    'error: CHATDDB_TOKEN is required. In a signed-in browser tab:\n' +
      '  await firebase.auth().currentUser.getIdToken()',
  )
  process.exit(2)
}

let passed = 0
let failed = 0
let skipped = 0

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

function skip(label, why) {
  console.log(`  - ${label} (skipped: ${why})`)
  skipped++
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

const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` })

/**
 * Sends one turn and drains the stream.
 *
 * Returns the assembled assistant text alongside the headers, because on this
 * path the two answer different questions: the header says whether an image was
 * generated, and the text says whether the model told the user the truth about
 * it.
 */
async function say(content, sessionId) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(sessionId ? { content, sessionId } : { content }),
  })
  if (res.status !== 200) {
    const body = await res.text()
    return { res, text: '', error: body.slice(0, 300), sessionId: null, fileId: null }
  }

  const raw = await res.text()
  // The frame shape `sse.ts` emits and `src/lib/api.ts` parses:
  // `data: {"choices":[{"delta":{"content":"…"}}]}`, then `data: [DONE]`. A
  // mid-stream failure arrives as `data: {"error":{"message":…}}` — after the
  // 200 headers were already committed, which is exactly why the status code
  // alone is not enough to call a turn successful.
  let text = ''
  let errored = null
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const frame = JSON.parse(payload)
      if (frame.error) errored = frame.error.message ?? 'error frame'
      const delta = frame.choices?.[0]?.delta?.content
      if (typeof delta === 'string') text += delta
    } catch {
      /* a frame we do not model; the assertions below cover what matters */
    }
  }

  return {
    res,
    text,
    error: errored,
    sessionId: res.headers.get('x-chatddb-session-id'),
    fileId: res.headers.get('x-chatddb-generated-file'),
  }
}

/** How many tool-image slots the user has already spent in today's window. */
function toolImageCount() {
  const rows = d1(
    `SELECT count FROM rate_counters
      WHERE action = 'tool_image' AND window_kind = 'day'
      ORDER BY window_start DESC LIMIT 1`,
  )
  return Number(rows[0]?.count ?? 0)
}

async function main() {
  console.log(`Chat image-tool smoke test (${BASE})\n`)

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json())
  console.log('health.ready:', JSON.stringify(health.ready))
  // The tool is armed off the same `resolveImageProviders` chain the button
  // uses, so a deployment with `ready.image === false` never offers it at all
  // and every case below would fail for an uninteresting reason.
  const armed = health.ready?.image === true
  check('image generation is configured', armed, String(health.ready?.image))

  const sessions = []

  // ---- 1. An implicit request, mid-conversation ----------------------------
  if (!armed) {
    skip('implicit request attaches a generated image', 'ready.image is false')
  } else if (SKIP_GENERATE) {
    skip('implicit request attaches a generated image', 'SKIP_GENERATE=1')
  } else {
    console.log('\n1. multi-turn implicit image request')
    const before = toolImageCount()

    const first = await say(
      'I am reading about lighthouses. What does a classic Fresnel-lens coastal ' +
        'lighthouse actually look like from the outside?',
    )
    check('the setup turn answered', first.res.status === 200 && first.text.length > 0, first.error ?? '')
    const sessionId = first.sessionId
    if (sessionId) sessions.push(sessionId)

    // No imperative, no mention of an image, no "generate" — the phrasing the
    // clause is written for.
    const second = await say('Can you show me one?', sessionId)
    check('the follow-up turn answered', second.res.status === 200, second.error ?? String(second.res.status))
    check('the stream carried no error frame', !second.error, String(second.error))
    check('an image was generated for the turn', Boolean(second.fileId), String(second.fileId))
    check('the reply has text introducing it', second.text.trim().length > 0, `${second.text.length} chars`)
    // `TOOL_RESULT_OK` tells the model never to write one, because the attachment
    // renders on its own and the link would point at nothing. It owns that rule
    // outright — `TOOL_USE_CLAUSE` deliberately says nothing about the reply's
    // wording, only that no prose may precede the call.
    check(
      'the reply invents no Markdown image link',
      !/!\[[^\]]*\]\(/.test(second.text),
      second.text.slice(0, 200),
    )

    // The tool consulted the rate limiter. Asserted through the counter rather
    // than by exhausting it here — case 3 does that deliberately, and doing it
    // twice would make this file unrunnable a second time in the same day.
    const after = toolImageCount()
    check('the tool consumed a tool_image slot', after === before + 1, `${before} → ${after}`)

    // Persistence runs in waitUntil, after the last frame.
    await new Promise((r) => setTimeout(r, 1500))

    console.log('\n   D1')
    const rows = d1(
      `SELECT role, attachment_count, finish_reason, length(message_content) AS chars
         FROM chat_messages WHERE session_id = '${sessionId}' ORDER BY created_at`,
    )
    console.log('  ', JSON.stringify(rows))
    const withImage = rows.filter((r) => r.role === 'assistant' && r.attachment_count === 1)
    check('one assistant row carries an attachment', withImage.length === 1, JSON.stringify(rows))
    check('that row also has text', (withImage[0]?.chars ?? 0) > 0, String(withImage[0]?.chars))

    const files = d1(
      `SELECT origin, upload_status, gen_model, message_id FROM files WHERE id = '${second.fileId}'`,
    )
    console.log('  ', JSON.stringify(files))
    check('the file is a stored generated image', files[0]?.origin === 'generated' && files[0]?.upload_status === 'stored', JSON.stringify(files[0]))
    // The whole reason `persistAssistant` attaches it: without a `message_id`
    // the row is an orphan and `listForSession` would never return it.
    check('the file is linked to a message', Boolean(files[0]?.message_id), String(files[0]?.message_id))

    const logs = d1(
      `SELECT action, metadata FROM activity_logs
        WHERE action = 'image_generated' ORDER BY timestamp DESC LIMIT 1`,
    )
    console.log('  ', JSON.stringify(logs))
    check(
      'an image_generated row was logged with kind=tool',
      String(logs[0]?.metadata ?? '').includes('"tool"'),
      String(logs[0]?.metadata),
    )

    // The transcript is where the image is actually seen today: nothing in
    // `src/` renders it live yet. If this passes and the live render does not
    // appear, that is the known follow-up, not a regression here.
    const view = await fetch(`${BASE}/api/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }).then((r) => r.json())
    const assistant = (view.messages ?? []).filter((m) => m.role === 'assistant')
    const attached = assistant.flatMap((m) => m.attachments ?? []).find((f) => f.origin === 'generated')
    check('the image survives a transcript reload', attached?.id === second.fileId, String(attached?.id))
  }

  // ---- 2. An ordinary question must not fire it ----------------------------
  //
  // The expensive failure mode is not a tool that never fires; it is one that
  // fires on every turn and drains a shared daily allowance by lunchtime.
  console.log('\n2. an ordinary question fires nothing')
  {
    const before = toolImageCount()
    const turn = await say('In two sentences, what is a B-tree and why do databases use one?')
    check('the question answered', turn.res.status === 200 && turn.text.length > 0, turn.error ?? '')
    check('no image was generated', turn.fileId === null, String(turn.fileId))
    check('no tool_image slot was consumed', toolImageCount() === before, `${before} → ${toolImageCount()}`)
    if (turn.sessionId) sessions.push(turn.sessionId)

    await new Promise((r) => setTimeout(r, 1200))
    const rows = d1(
      `SELECT attachment_count FROM chat_messages
        WHERE session_id = '${turn.sessionId}' AND role = 'assistant'`,
    )
    check('the assistant row has no attachment', rows.every((r) => r.attachment_count === 0), JSON.stringify(rows))
  }

  // ---- 3. The daily tool cap is a wall, not a suggestion -------------------
  //
  // Runs last because it deliberately spends the rest of the day's tool budget.
  // The counter is driven straight into D1 rather than by generating images:
  // burning `RATE_TOOL_IMAGE_PER_DAY` real images to prove a limit works would
  // cost more allowance than the limit is protecting.
  console.log('\n3. past the daily tool cap → a plain explanation, not a silent no-op')
  {
    const users = d1(`SELECT DISTINCT subject FROM rate_counters WHERE subject LIKE 'user:%' LIMIT 5`)
    const subject = users.find((u) => u.subject)?.subject
    if (!subject) {
      skip('the cap produces a plain-text explanation', 'no rate_counters subject to exhaust')
    } else {
      const day = Math.floor(Date.now() / 86_400_000) * 86_400_000
      d1(
        `INSERT INTO rate_counters (subject, window_kind, action, window_start, count)
         VALUES ('${subject}', 'day', 'tool_image', ${day}, 9999)
         ON CONFLICT (subject, window_kind, action, window_start) DO UPDATE SET count = 9999`,
      )

      const turn = await say(
        'I am reading about lighthouses. Can you show me what a classic coastal one looks like?',
      )
      // The turn must still be a normal, successful turn. A 429 escaping to the
      // client here would be the bug: the user asked a question, and the answer
      // is "I cannot draw that today", not an HTTP error.
      check('the turn still succeeds', turn.res.status === 200, `${turn.res.status} ${turn.error ?? ''}`)
      check('no image was attached', turn.fileId === null, String(turn.fileId))
      check('the reply is not empty', turn.text.trim().length > 0, `${turn.text.length} chars`)
      // The model relays `limitToolImage`'s message in its own words. Matching
      // on the concepts rather than the sentence, because the wording is the
      // model's — probe phase 4 measured 5/5 on this behaviour, not on phrasing.
      const lower = turn.text.toLowerCase()
      check(
        'the reply explains the refusal in plain words',
        /limit|reached|unable|can'?t|cannot|unavailable/.test(lower),
        turn.text.slice(0, 200),
      )
      if (turn.sessionId) sessions.push(turn.sessionId)

      await new Promise((r) => setTimeout(r, 1200))
      const logs = d1(
        `SELECT metadata FROM activity_logs WHERE action = 'rate_limited'
          ORDER BY timestamp DESC LIMIT 1`,
      )
      check(
        'the refusal was audited as a tool_image rate limit',
        String(logs[0]?.metadata ?? '').includes('tool_image'),
        String(logs[0]?.metadata),
      )

      // Put the counter back where it was found, so the next run of this script
      // — and the developer's next ordinary use of the app — is not blocked.
      d1(
        `UPDATE rate_counters SET count = 1
          WHERE subject = '${subject}' AND action = 'tool_image'
            AND window_kind = 'day' AND window_start = ${day}`,
      )
      console.log('   (tool_image counter reset to 1)')
    }
  }

  for (const id of sessions) {
    await fetch(`${BASE}/api/sessions/${id}`, {
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
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
    process.exit(failed === 0 ? 0 : 1)
  })
