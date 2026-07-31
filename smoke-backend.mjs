#!/usr/bin/env node

/**
 * Backend smoke test: drives `POST /api/chat` against the real Worker and the
 * real AgentRouter model, and asserts a completion comes back as SSE.
 *
 * ## Why this is no longer a browser test
 *
 * It used to drive the UI with Playwright and watch the assistant bubble grow.
 * Phase 2 put Google sign-in in front of the chat, and a headless browser cannot
 * complete that flow, so the UI path is unreachable from a script. The check
 * moved down to the API, where a token is all that is needed.
 *
 * It also means this script cannot assert *progressive* rendering, and must not
 * try: AgentRouter buffers the whole completion and hands the Worker one large
 * delta, so the typing effect is paced client-side in `src/lib/api.ts`. One
 * delta over the wire is the expected shape, not a regression.
 *
 * Usage:
 *   node smoke-backend.mjs                        # health only
 *   CHATDDB_TOKEN=<id-token> node smoke-backend.mjs
 *
 * Get a token from the browser console while signed in:
 *   await firebase.auth().currentUser.getIdToken()
 *
 * Needs the Worker up: `npm run dev:worker` (or `npm run dev:all`).
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:8787'
const TOKEN = process.env.CHATDDB_TOKEN

let passed = 0
let failed = 0

async function test(label, fn) {
  try {
    await fn()
    console.log(`  ✓ ${label}`)
    passed++
  } catch (err) {
    console.log(`  ✗ ${label}: ${err.message}`)
    failed++
  }
}

function chat(body, token) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(`${BASE}/api/chat`, { method: 'POST', headers, body: JSON.stringify(body) })
}

/**
 * Reads the client-facing SSE stream. `worker/sse.ts` normalises every upstream
 * quirk into `data: {"choices":[{"delta":{"content":"…"}}]}` frames terminated
 * by `data: [DONE]`, plus `data: {"error":{…}}` for a mid-stream failure — so
 * only those three shapes need handling here.
 */
async function readStream(res) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let deltas = 0
  let done = false
  let error = null

  for (;;) {
    const { done: end, value } = await reader.read()
    if (end) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') {
        done = true
        continue
      }
      let frame
      try {
        frame = JSON.parse(payload)
      } catch {
        continue
      }
      if (frame.error) {
        error = frame.error
        continue
      }
      const delta = frame.choices?.[0]?.delta?.content
      if (typeof delta === 'string' && delta.length > 0) {
        text += delta
        deltas++
      }
    }
  }

  return { text, deltas, done, error }
}

async function main() {
  console.log(`Backend smoke test (${BASE})`)

  // The Worker must have a key before any of this means anything. `configured`
  // is a top-level field on the health body and is read as `health.configured`
  // — keep this assertion exactly as it is (see worker/index.ts).
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json())
  console.log('HEALTH:', JSON.stringify(health))
  if (!health.configured) {
    console.error('FAIL: Worker has no AGENTROUTER_API_KEY — a chat request cannot reach the model.')
    process.exit(1)
  }

  // The chat route is authenticated now. Prove the gate is in front of it even
  // when there is no token to test the happy path with.
  await test('POST /api/chat (no token) → 401 no_session', async () => {
    const res = await chat({ content: 'hello' })
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`)
    const body = await res.json()
    if (body?.error?.type !== 'no_session') {
      throw new Error(`Expected type no_session, got ${body?.error?.type}`)
    }
  })

  if (!TOKEN) {
    console.log('  (skipping the completion test — set CHATDDB_TOKEN)')
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  }

  // A stale frontend still sends `{messages: [...]}`. That must fail loudly with
  // the diagnostic, not be silently accepted.
  await test('POST /api/chat (legacy `messages` body) → 400 legacy_client', async () => {
    const res = await chat({ messages: [{ role: 'user', content: 'hi' }] }, TOKEN)
    if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`)
    const body = await res.json()
    if (body?.error?.type !== 'legacy_client') {
      throw new Error(`Expected type legacy_client, got ${body?.error?.type}`)
    }
  })

  let sessionId = null

  await test('POST /api/chat → 200 SSE with a real completion', async () => {
    const res = await chat(
      { content: 'In about 70 words, explain what a Cloudflare Worker is and why it suits an API proxy.' },
      TOKEN,
    )
    if (res.status !== 200) {
      const body = await res.text()
      throw new Error(`Expected 200, got ${res.status}: ${body.slice(0, 200)}`)
    }
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      throw new Error(`Expected text/event-stream, got ${contentType}`)
    }

    // A new conversation was created server-side; the id comes back on a header
    // so the client can adopt it without a second round-trip.
    sessionId = res.headers.get('X-ChatDDB-Session-Id')
    if (!sessionId) throw new Error('Missing X-ChatDDB-Session-Id header')
    if (!res.headers.get('X-ChatDDB-Model')) throw new Error('Missing X-ChatDDB-Model header')

    const { text, deltas, done, error } = await readStream(res)
    console.log(`    DELTAS: ${deltas}  CHARS: ${text.length}  MODEL: ${res.headers.get('X-ChatDDB-Model')}`)
    console.log('    REPLY_HEAD:', JSON.stringify(text.slice(0, 140)))

    if (error) throw new Error(`Mid-stream error frame: ${error.type} ${error.message}`)
    if (!done) throw new Error('Stream ended without a [DONE] frame')
    if (deltas < 1) throw new Error('No content deltas arrived')
    if (text.length < 80) throw new Error(`Reply too short (${text.length} chars) — did the model answer?`)
    if (/placeholder response/i.test(text)) throw new Error('Got the mock reply, not a real completion')
  })

  // The turn is persisted after the last frame via `ctx.waitUntil`, so the rows
  // land just behind the stream rather than during it — poll rather than read
  // once, or this races the write it is checking for.
  if (sessionId) {
    await test('GET /api/sessions/:id → the turn was persisted', async () => {
      let roles = []
      for (let attempt = 0; attempt < 10; attempt++) {
        const res = await fetch(`${BASE}/api/sessions/${sessionId}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
        if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`)
        const body = await res.json()
        roles = (body.messages ?? []).map((m) => m.role)
        if (roles.includes('user') && roles.includes('assistant')) return
        await new Promise((r) => setTimeout(r, 300))
      }
      throw new Error(`Turn not persisted after 3s (roles: ${roles.join(',') || 'none'})`)
    })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
