#!/usr/bin/env node

/**
 * Image generation smoke tests.
 *
 * Usage:
 *   CHATDDB_TOKEN=<id-token> node scripts/smoke-images.mjs
 *
 * Get a token from the browser console:
 *   await firebase.auth().currentUser.getIdToken()
 *
 * ## This one spends money
 *
 * Unlike the other smoke scripts, the happy path here runs a real model on a
 * real Cloudflare account -- Workers AI has no local mode, so `wrangler dev`
 * proxies to the same account and the same 10,000-neuron daily allowance as
 * production. One run costs roughly 58 neurons (one 1024x1024 four-step image),
 * about 0.6% of a day's free budget.
 *
 * Set SKIP_GENERATE=1 to run only the validation cases, which cost nothing
 * because they are refused before the model is ever called.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:8787'
const TOKEN = process.env.CHATDDB_TOKEN
const SKIP_GENERATE = process.env.SKIP_GENERATE === '1'

if (!TOKEN) {
  console.error('error: CHATDDB_TOKEN is required')
  process.exit(1)
}

let passed = 0
let failed = 0
let skipped = 0

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

function skip(label, why) {
  console.log(`  - ${label} (skipped: ${why})`)
  skipped++
}

async function main() {
  console.log(`Image smoke tests (${BASE})`)

  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

  // Is the feature even wired up on this deployment? Everything below depends on
  // it, and "all tests failed" is a much worse report than "not configured".
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json())
  const available = health?.ready?.image === true
  console.log(`  · ready.image = ${available}`)

  // 1. Auth is required.
  await test('POST /api/images without a token → 401', async () => {
    const res = await fetch(`${BASE}/api/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'a red bicycle' }),
    })
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`)
  })

  // 2. An empty prompt is refused before the model is called.
  await test('POST /api/images with an empty prompt → 400', async () => {
    const res = await fetch(`${BASE}/api/images`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: '   ' }),
    })
    if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`)
  })

  // 3. Over flux-1-schnell's documented 2048-character ceiling.
  await test('POST /api/images with a 3000-char prompt → 400', async () => {
    const res = await fetch(`${BASE}/api/images`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: 'a'.repeat(3000) }),
    })
    if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`)
  })

  // 4. A session id that is not a UUID.
  await test('POST /api/images with a malformed sessionId → 400', async () => {
    const res = await fetch(`${BASE}/api/images`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: 'a red bicycle', sessionId: 'not-a-uuid' }),
    })
    if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`)
  })

  // 5. Someone else's session must 404, not 403 -- a different answer for each
  //    would confirm the id exists.
  await test('POST /api/images with an unknown sessionId → 404', async () => {
    const res = await fetch(`${BASE}/api/images`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: 'a red bicycle',
        sessionId: '00000000-0000-4000-8000-000000000000',
      }),
    })
    if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`)
  })

  // 6. The happy path. Everything above this line is free.
  let fileId = null
  let sessionId = null

  if (!available) {
    skip('POST /api/images → 201 with a generated file', 'ready.image is false')
  } else if (SKIP_GENERATE) {
    skip('POST /api/images → 201 with a generated file', 'SKIP_GENERATE=1')
  } else {
    await test('POST /api/images → 201 with a generated file', async () => {
      const res = await fetch(`${BASE}/api/images`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt: 'a red bicycle on a white background' }),
      })
      const body = await res.json()
      if (res.status !== 201) {
        throw new Error(`Expected 201, got ${res.status} ${body?.error?.message ?? ''}`)
      }
      if (body?.file?.origin !== 'generated') {
        throw new Error(`Expected origin 'generated', got '${body?.file?.origin}'`)
      }
      if (body?.file?.uploadStatus !== 'stored') {
        throw new Error(`Expected uploadStatus 'stored', got '${body?.file?.uploadStatus}'`)
      }
      if (body?.file?.mimeType !== 'image/jpeg') {
        throw new Error(`Expected image/jpeg, got '${body?.file?.mimeType}'`)
      }
      if (!body?.file?.genPrompt) throw new Error('Missing genPrompt on the file')
      if (!body?.messageId) throw new Error('Missing messageId')
      fileId = body.file.id
      sessionId = body.sessionId
    })
  }

  // 7. The bytes come back through the ordinary signed-URL path, and are a JPEG.
  if (fileId) {
    await test('GET /api/files/:id/url → signed URL serving JPEG bytes', async () => {
      const res = await fetch(`${BASE}/api/files/${fileId}/url`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`)
      const { url } = await res.json()
      if (!url) throw new Error('Missing url')

      const view = await fetch(`${BASE}${url}`)
      if (view.status !== 200) throw new Error(`Expected 200 from view, got ${view.status}`)
      const bytes = new Uint8Array(await view.arrayBuffer())
      // FF D8 FF is the JPEG SOI marker. The Worker checks this too, before
      // storing; this confirms what actually came back out of R2.
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
        throw new Error('Stored bytes are not a JPEG')
      }
    })
  }

  // 8. The image survives a transcript reload, which is the whole reason it is
  //    attached to the assistant message rather than returned inline.
  if (sessionId) {
    await test('GET /api/sessions/:id → image present on the assistant turn', async () => {
      const res = await fetch(`${BASE}/api/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`)
      const { messages } = await res.json()
      const assistant = messages.find((m) => m.role === 'assistant')
      if (!assistant) throw new Error('No assistant message in the transcript')
      const generated = (assistant.attachments ?? []).find((f) => f.origin === 'generated')
      if (!generated) throw new Error('Assistant turn carries no generated attachment')
      if (generated.id !== fileId) throw new Error('Attached file is not the generated one')
    })
  }

  // Clean up: the session cascades to its messages, and the file row with it.
  if (sessionId) {
    await fetch(`${BASE}/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` },
    }).catch(() => {})
  }
  if (fileId) {
    await fetch(`${BASE}/api/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` },
    }).catch(() => {})
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
