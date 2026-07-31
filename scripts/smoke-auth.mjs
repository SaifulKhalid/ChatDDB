#!/usr/bin/env node

/**
 * Auth smoke tests.
 *
 * Usage:
 *   node scripts/smoke-auth.mjs                 # unauthenticated tests only
 *   CHATDDB_TOKEN=<id-token> node scripts/smoke-auth.mjs
 *
 * Get a token from the browser console:
 *   await firebase.auth().currentUser.getIdToken()
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

async function get(path, token) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(`${BASE}${path}`, { headers })
}

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

async function main() {
  console.log(`Auth smoke tests (${BASE})`)

  // Health
  await test('GET /api/health → 200', async () => {
    const res = await get('/api/health')
    const body = await res.json()
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`)
    // `configured` is a top-level field (worker/index.ts), and the root
    // smoke-backend.mjs reads it as `health.configured` on the parsed body.
    // Do not reshape it into a nested `health` object.
    if (typeof body.configured !== 'boolean') {
      throw new Error('configured is not present at top level')
    }
    if (!body.ready || typeof body.ready.auth !== 'boolean') {
      throw new Error('ready.auth is missing')
    }
  })

  // No token → 401
  await test('GET /api/me (no token) → 401 no_session', async () => {
    const res = await get('/api/me')
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`)
    const body = await res.json()
    if (body?.error?.type !== 'no_session') throw new Error(`Expected type no_session, got ${body?.error?.type}`)
  })

  // Bad token → 401
  await test('GET /api/me (bad token) → 401 invalid_token', async () => {
    const res = await get('/api/me', 'definitely-not-a-real-token')
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`)
    const body = await res.json()
    if (body?.error?.type !== 'invalid_token') throw new Error(`Expected type invalid_token, got ${body?.error?.type}`)
  })

  // Good token — only when provided
  if (TOKEN) {
    await test('GET /api/me (good token) → 200 with fields', async () => {
      const res = await get('/api/me', TOKEN)
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`)
      const body = await res.json()
      if (!body.user) throw new Error('Missing user')
      if (!body.usage) throw new Error('Missing usage')
      if (!body.quota) throw new Error('Missing quota')
      if (!body.models) throw new Error('Missing models')
      if (!body.pdfExtractMode) throw new Error('Missing pdfExtractMode')
    })

    await test('POST /api/auth/session → 200', async () => {
      const res = await post('/api/auth/session', {}, TOKEN)
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`)
      const body = await res.json()
      if (!body.user) throw new Error('Missing user')
    })

    // Whether this token is an admin depends on ADMIN_EMAILS, and
    // smoke-admin.mjs needs an admin token — so assert the gate exists rather
    // than the caller's role. What must never appear is 404 or 5xx: the
    // permission boundary is 401/403 only.
    await test('GET /api/admin/stats → 200 (admin) or 403 (not admin)', async () => {
      const res = await get('/api/admin/stats', TOKEN)
      if (res.status === 200) {
        console.log('    (token is an admin — run smoke-admin.mjs with it)')
        return
      }
      if (res.status !== 403) throw new Error(`Expected 200 or 403, got ${res.status}`)
      const body = await res.json()
      if (body?.error?.type !== 'forbidden') {
        throw new Error(`Expected type forbidden, got ${body?.error?.type}`)
      }
    })
  } else {
    console.log('  (skipping authenticated tests — set CHATDDB_TOKEN)')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
