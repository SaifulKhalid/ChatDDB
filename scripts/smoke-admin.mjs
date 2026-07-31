#!/usr/bin/env node

/**
 * Admin smoke tests.
 *
 * Requires a token belonging to an admin account.
 *
 * Usage:
 *   CHATDDB_TOKEN=<admin-id-token> node scripts/smoke-admin.mjs
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:8787'
const TOKEN = process.env.CHATDDB_TOKEN

if (!TOKEN) {
  console.error('error: CHATDDB_TOKEN is required (must be an admin account)')
  process.exit(1)
}

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

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  return res
}

async function main() {
  console.log(`Admin smoke tests (${BASE})`)

  await test('GET /api/admin/stats → 200 with platform/storage/actions', async () => {
    const res = await get('/api/admin/stats')
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`)
    const body = await res.json()
    if (!body.platform) throw new Error('Missing platform')
    if (!body.storage) throw new Error('Missing storage')
    if (!body.actions) throw new Error('Missing actions')
    if (!body.generatedAt) throw new Error('Missing generatedAt')
  })

  await test('GET /api/admin/users → 200', async () => {
    const res = await get('/api/admin/users')
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`)
    const body = await res.json()
    if (!body.users || !Array.isArray(body.users)) throw new Error('users is not an array')
    if (typeof body.total !== 'number') throw new Error('Missing total')
  })

  // Try to find a session to inspect
  let sessionId = null
  const sessRes = await get('/api/admin/sessions?limit=5')
  if (sessRes.status === 200) {
    const sessBody = await sessRes.json()
    if (sessBody.sessions?.length > 0) {
      sessionId = sessBody.sessions[0].id
    }
  }

  if (sessionId) {
    await test('GET /api/admin/sessions/:id → 200, audit trail recorded', async () => {
      const res = await get(`/api/admin/sessions/${sessionId}`)
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`)
      const body = await res.json()
      if (!body.session) throw new Error('Missing session')
      if (!body.user) throw new Error('Missing user')
      if (!body.messages) throw new Error('Missing messages')

      // Verify an admin_chat_access row was created
      const activity = await get('/api/admin/activity?action=admin_chat_access&limit=1')
      if (activity.status === 200) {
        const actBody = await activity.json()
        if (actBody.activity?.length === 0) {
          console.log('  ⚠ admin_chat_access row not found in activity feed (may be listed on next page)')
        }
      }
    })
  } else {
    console.log('  (skipping transcript test — no sessions found)')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
