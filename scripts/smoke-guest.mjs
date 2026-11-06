#!/usr/bin/env node

/**
 * End-to-end smoke tests for Guest Mode in ChatDDB.
 *
 * Verifies all 10 requirements:
 *  1. Guest session creation (POST /api/auth/session with anonymous token)
 *  2. A chat turn (guest chats, session created, SSE stream returned, messages stored)
 *  3. History persists across a token refresh (new session check retains sessions)
 *  4. Guest rate caps (enforces tier-specific chat limits & helpful sign-in message)
 *  5. Creation cap per IP (blocks excessive guest creations from same IP with 429)
 *  6. Admin list shows the guest (with isGuest badge & split statistics)
 *  7. Admin can read the guest's history and logs (inspect sessions & activity)
 *  8. Guest cannot reach admin (403 admin_required & logs suspicious_activity)
 *  9. Link-upgrade keeps the history (Google link preserves uid & chat history)
 * 10. Admin-email promotion never applies to guests (immune to ADMIN_EMAILS matching)
 * +  Bonus: Merge-guest endpoint (reassigns history to existing Google account)
 *
 * Usage:
 *   node --experimental-strip-types scripts/smoke-guest.mjs
 */

import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import worker from '../worker/index.ts'

let passed = 0
let failed = 0

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

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

/** Creates an in-memory SQLite database running migrations 0001 through 0009 */
function createMockD1() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON;')

  const migrations = [
    'migrations/0001_users_and_activity.sql',
    'migrations/0002_chat_sessions_and_messages.sql',
    'migrations/0003_files.sql',
    'migrations/0004_rate_counters.sql',
    'migrations/0005_session_title_provenance.sql',
    'migrations/0006_generated_images.sql',
    'migrations/0007_ai_services_and_routing.sql',
    'migrations/0008_drop_db_ai_routing.sql',
    'migrations/0009_guest_mode.sql',
  ]

  for (const m of migrations) {
    const sql = readFileSync(resolve(m), 'utf-8')
    sqlite.exec(sql)
  }

  function createStatement(sql, params = []) {
    return {
      bind(...newParams) {
        return createStatement(sql, newParams)
      },
      async first() {
        const stmt = sqlite.prepare(sql)
        const row = stmt.get(...params)
        return row ?? null
      },
      async all() {
        const stmt = sqlite.prepare(sql)
        const rows = stmt.all(...params)
        return { results: rows }
      },
      async run() {
        const stmt = sqlite.prepare(sql)
        const info = stmt.run(...params)
        return {
          meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
        }
      },
    }
  }

  return {
    prepare(sql) {
      return createStatement(sql)
    },
    async batch(statements) {
      const results = []
      sqlite.exec('BEGIN TRANSACTION')
      try {
        for (const s of statements) {
          results.push(await s.run())
        }
        sqlite.exec('COMMIT')
        return results
      } catch (err) {
        sqlite.exec('ROLLBACK')
        throw err
      }
    },
  }
}

function createMockR2() {
  const map = new Map()
  return {
    async put(key, value, options) {
      map.set(key, { value, options })
      return { key, size: value?.byteLength ?? 0 }
    },
    async get(key) {
      if (!map.has(key)) return null
      const item = map.get(key)
      return {
        body: item.value,
        async arrayBuffer() { return item.value },
        async text() { return new TextDecoder().decode(item.value) },
      }
    },
    async delete(key) {
      map.delete(key)
    },
  }
}

function makeEnv(db, r2, overrides = {}) {
  return {
    DB: db,
    FILES: r2,
    FIREBASE_PROJECT_ID: 'test-project',
    ADMIN_EMAILS: 'admin@example.com',
    IP_HASH_SALT: 'test-salt-12345',
    AGENTROUTER_API_KEY: 'mock-agentrouter-key',
    RATE_GUEST_CREATE_PER_DAY: '5',
    RATE_GUEST_CREATE_PER_MIN: '3',
    RATE_GUEST_CHAT_PER_DAY: '50',
    RATE_GUEST_UPLOAD_PER_DAY: '20',
    RATE_AUTH_PER_MIN: '100',
    ...overrides,
  }
}

const pendingPromises = []
const execContext = {
  waitUntil(p) {
    if (p && typeof p.then === 'function') {
      pendingPromises.push(p)
    }
  },
  passThroughOnException() {},
  async drain() {
    while (pendingPromises.length > 0) {
      const p = pendingPromises.shift()
      await p.catch(() => {})
    }
  },
}

/** Helper to dispatch requests into worker.fetch */
async function dispatch(env, path, options = {}) {
  const { method = 'GET', headers = {}, body, token, ip = '192.168.1.100' } = options
  const reqHeaders = new Headers(headers)
  if (token) reqHeaders.set('Authorization', `Bearer ${token}`)
  if (body !== undefined && !reqHeaders.has('Content-Type')) {
    reqHeaders.set('Content-Type', 'application/json')
  }
  reqHeaders.set('CF-Connecting-IP', ip)
  reqHeaders.set('User-Agent', 'SmokeTestRunner/1.0')

  const request = new Request(`http://localhost:8787${path}`, {
    method,
    headers: reqHeaders,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  })

  return await worker.fetch(request, env, execContext)
}

function makeTestToken(payload) {
  return `test:${JSON.stringify(payload)}`
}

async function main() {
  console.log('\n======================================================')
  console.log('Guest Mode End-to-End Smoke Test Suite')
  console.log('======================================================\n')

  // Setup mock fetch for upstream AI provider
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const urlStr = String(url)
    if (urlStr.includes('agentrouter.org') || urlStr.includes('api.openai.com')) {
      const sseBody = [
        'data: {"type":"response.output_text.delta","delta":"Hello guest!"}\n\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n',
      ].join('')

      return new Response(sseBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      })
    }
    return originalFetch(url, init)
  }

  const db = createMockD1()
  const r2 = createMockR2()
  const env = makeEnv(db, r2)

  let guestUser = null
  const guestUid = 'smoke-anon-uid-100'
  const guestToken = makeTestToken({ uid: guestUid, provider: 'anonymous' })

  // 1. Guest session creation
  await test('1. Guest session creation (POST /api/auth/session with anonymous token)', async () => {
    const res = await dispatch(env, '/api/auth/session', {
      method: 'POST',
      token: guestToken,
    })
    assert(res.status === 200, `Expected 200, got ${res.status}`)
    const data = await res.json()
    assert(data.user, 'user object returned')
    assert(data.user.isGuest === true, 'user.isGuest is true')
    assert(data.user.role === 'user', 'user.role is user')
    assert(data.user.name === 'Guest', 'user.name is Guest')
    assert(data.user.email.startsWith('guest-'), 'user.email is synthetic guest email')
    guestUser = data.user

    // Check activity log
    const log = await db.prepare("SELECT * FROM activity_logs WHERE user_id = ? AND action = 'guest_created'")
      .bind(guestUser.id).first()
    assert(log !== null, 'activity log guest_created recorded')
  })

  // 2. A chat turn
  let sessionId = null
  await test('2. A chat turn (guest chats, session created, SSE stream returned, messages stored)', async () => {
    const res = await dispatch(env, '/api/chat', {
      method: 'POST',
      token: guestToken,
      body: {
        content: 'Hi from guest!',
        service: 'chatgpt',
        attachments: [],
      },
    })
    assert(res.status === 200, `Expected 200, got ${res.status}`)
    assert(res.headers.get('content-type')?.includes('text/event-stream'), 'returns SSE stream')

    // Read stream to completion so execution completes
    const text = await res.text()
    await execContext.drain()
    assert(text.includes('Hello guest!'), 'stream contains model response')

    // Verify session was created in DB
    const sess = await db.prepare('SELECT * FROM chat_sessions WHERE user_id = ?').bind(guestUser.id).first()
    assert(sess !== null, 'chat session exists in DB')
    assert(sess.message_count >= 1, 'session message_count is incremented')
    sessionId = sess.id

    // Verify messages stored in DB
    const msgs = await db.prepare('SELECT * FROM chat_messages WHERE session_id = ?').bind(sessionId).all()
    assert(msgs.results.length >= 1, 'chat messages stored')
  })

  // 3. History persists across a token refresh
  await test('3. History persists across a token refresh (new session check retains sessions)', async () => {
    // Simulated token refresh: call /api/auth/session again with same uid
    const resAuth = await dispatch(env, '/api/auth/session', {
      method: 'POST',
      token: guestToken,
    })
    assert(resAuth.status === 200, 'session exchange succeeds on token refresh')
    const authData = await resAuth.json()
    assert(authData.user.id === guestUser.id, 'user ID unchanged')

    // List sessions
    const resSessions = await dispatch(env, '/api/sessions', {
      token: guestToken,
    })
    assert(resSessions.status === 200, 'GET /api/sessions succeeds')
    const sessData = await resSessions.json()
    assert(sessData.sessions.length >= 1, 'sessions list is not empty')
    assert(sessData.sessions.some(s => s.id === sessionId), 'original session is present')

    // Check transcript
    const resTranscript = await dispatch(env, `/api/sessions/${sessionId}`, {
      token: guestToken,
    })
    assert(resTranscript.status === 200, 'GET /api/sessions/:id succeeds')
    const transcriptData = await resTranscript.json()
    assert(transcriptData.session.id === sessionId, 'transcript matches session')
    assert(transcriptData.messages.length >= 1, 'transcript contains messages')
  })

  // 4. Guest rate caps
  await test('4. Guest rate caps (enforces tier-specific chat limit with upgrade guidance)', async () => {
    // Check /api/me quota reported for guest
    const resMe = await dispatch(env, '/api/me', { token: guestToken })
    assert(resMe.status === 200, 'GET /api/me succeeds')
    const meData = await resMe.json()
    assert(meData.user.isGuest === true, 'isGuest is true in /api/me')
    assert(meData.quota.chatPerDay === 50, 'quota.chatPerDay is 50 for guest')
    assert(meData.quota.uploadPerDay === 20, 'quota.uploadPerDay is 20 for guest')

    // Test cap enforcement with a custom capped env
    const cappedEnv = makeEnv(db, r2, { RATE_GUEST_CHAT_PER_DAY: '1' })
    // We already performed 1 chat turn, so the next should be blocked with 429
    const blockedRes = await dispatch(cappedEnv, '/api/chat', {
      method: 'POST',
      token: guestToken,
      body: { content: 'Exceeding limit', service: 'chatgpt', attachments: [] },
    })
    assert(blockedRes.status === 429, `Expected 429, got ${blockedRes.status}`)
    const errBody = await blockedRes.json()
    assert(errBody.error?.type === 'rate_limited', 'error type is rate_limited')
    assert(errBody.error?.message?.includes('Sign in with Google'), 'message includes Google sign-in guidance')
  })

  // 5. Creation cap per IP
  await test('5. Creation cap per IP (blocks excessive guest creations from same IP with 429)', async () => {
    const ipLimitedEnv = makeEnv(db, r2, {
      RATE_GUEST_CREATE_PER_DAY: '2',
      RATE_GUEST_CREATE_PER_MIN: '2',
    })
    const testIp = '10.0.0.99'

    // First guest from IP
    const g1 = await dispatch(ipLimitedEnv, '/api/auth/session', {
      method: 'POST',
      token: makeTestToken({ uid: 'ip-test-guest-1', provider: 'anonymous' }),
      ip: testIp,
    })
    assert(g1.status === 200, '1st guest creation from IP allowed')

    // Second guest from IP
    const g2 = await dispatch(ipLimitedEnv, '/api/auth/session', {
      method: 'POST',
      token: makeTestToken({ uid: 'ip-test-guest-2', provider: 'anonymous' }),
      ip: testIp,
    })
    assert(g2.status === 200, '2nd guest creation from IP allowed')

    // Third guest from same IP -> blocked by creation rate limit
    const g3 = await dispatch(ipLimitedEnv, '/api/auth/session', {
      method: 'POST',
      token: makeTestToken({ uid: 'ip-test-guest-3', provider: 'anonymous' }),
      ip: testIp,
    })
    assert(g3.status === 429, `Expected 429, got ${g3.status}`)
    const errData = await g3.json()
    assert(errData.error?.type === 'rate_limited', 'error type is rate_limited')

    // Verify rate limit was logged
    const rateLog = await db.prepare("SELECT * FROM activity_logs WHERE action = 'rate_limited' AND ip_hash IS NOT NULL")
      .first()
    assert(rateLog !== null, 'rate_limited activity log was recorded')
  })

  // Admin token setup
  const adminToken = makeTestToken({
    uid: 'smoke-admin-uid-1',
    email: 'admin@example.com',
    emailVerified: true,
    provider: 'google.com',
  })
  // Establish admin session
  await dispatch(env, '/api/auth/session', { method: 'POST', token: adminToken })

  // 6. Admin list shows the guest
  await test('6. Admin list shows the guest (with isGuest badge & split statistics)', async () => {
    const resStats = await dispatch(env, '/api/admin/stats', { token: adminToken })
    assert(resStats.status === 200, 'GET /api/admin/stats succeeds')
    const statsData = await resStats.json()
    assert(statsData.platform.guestUsers >= 1, 'platform stats has guestUsers')
    assert(statsData.platform.registeredUsers >= 1, 'platform stats has registeredUsers')

    // List all users
    const resAll = await dispatch(env, '/api/admin/users', { token: adminToken })
    assert(resAll.status === 200, 'GET /api/admin/users succeeds')
    const allData = await resAll.json()
    const guestEntry = allData.users.find(u => u.id === guestUser.id)
    assert(guestEntry !== undefined, 'guest is present in admin users list')
    assert(guestEntry.isGuest === true, 'guest has isGuest: true')

    // Filter by guest
    const resGuestsOnly = await dispatch(env, '/api/admin/users?guest=guest', { token: adminToken })
    const guestOnlyData = await resGuestsOnly.json()
    assert(guestOnlyData.users.every(u => u.isGuest === true), 'all returned users are guests')

    // Filter by registered
    const resRegOnly = await dispatch(env, '/api/admin/users?guest=registered', { token: adminToken })
    const regOnlyData = await resRegOnly.json()
    assert(regOnlyData.users.every(u => u.isGuest === false), 'all returned users are registered')
  })

  // 7. Admin can read the guest's history and logs
  await test("7. Admin can read the guest's history and logs (inspect sessions & activity)", async () => {
    // Admin inspects sessions
    const resSessions = await dispatch(env, `/api/admin/sessions?userId=${guestUser.id}`, { token: adminToken })
    assert(resSessions.status === 200, 'GET /api/admin/sessions succeeds')
    const sessList = await resSessions.json()
    assert(sessList.sessions.length >= 1, 'admin can see guest sessions')
    assert(sessList.sessions[0].user.isGuest === true, 'session user has isGuest: true')

    // Admin inspects session transcript
    const resTranscript = await dispatch(env, `/api/admin/sessions/${sessionId}`, { token: adminToken })
    assert(resTranscript.status === 200, 'GET /api/admin/sessions/:id succeeds')
    const transcript = await resTranscript.json()
    assert(transcript.session.id === sessionId, 'transcript matches')
    assert(transcript.user.isGuest === true, 'transcript user has isGuest: true')

    // Admin inspects guest activity logs
    const resActivity = await dispatch(env, `/api/admin/activity?userId=${guestUser.id}`, { token: adminToken })
    assert(resActivity.status === 200, 'GET /api/admin/activity succeeds')
    const actData = await resActivity.json()
    assert(actData.activity.length >= 1, 'admin can see guest activity logs')
    assert(actData.activity.some(l => l.action === 'guest_created' || l.action === 'chat_started'), 'actions include guest events')
  })

  // 8. Guest cannot reach admin
  await test('8. Guest cannot reach admin (403 admin_required & logs suspicious_activity)', async () => {
    const res = await dispatch(env, '/api/admin/users', { token: guestToken })
    assert(res.status === 403, `Expected 403, got ${res.status}`)
    const errData = await res.json()
    assert(errData.error?.type === 'admin_required', 'error type is admin_required')

    // Verify suspicious_activity was logged for this guest
    const suspLog = await db.prepare("SELECT * FROM activity_logs WHERE user_id = ? AND action = 'suspicious_activity'")
      .bind(guestUser.id).first()
    assert(suspLog !== null, 'suspicious_activity logged for guest attempting admin access')
  })

  // 9. Link-upgrade keeps the history
  await test('9. Link-upgrade keeps the history (Google link preserves uid & chat history)', async () => {
    // User links with Google: same uid, but provider is now Google with real email/name
    const upgradedToken = makeTestToken({
      uid: guestUid,
      email: 'upgraded.guest@example.com',
      name: 'Upgraded Person',
      provider: 'google.com',
      emailVerified: true,
    })

    const res = await dispatch(env, '/api/auth/session', {
      method: 'POST',
      token: upgradedToken,
    })
    assert(res.status === 200, 'upgraded session exchange succeeds')
    const data = await res.json()
    assert(data.user.id === guestUser.id, 'user ID is preserved')
    assert(data.user.isGuest === false, 'user.isGuest is now false')
    assert(data.user.email === 'upgraded.guest@example.com', 'user.email is updated to Google email')
    assert(data.user.name === 'Upgraded Person', 'user.name is updated')

    // Check that chat history is completely preserved
    const resSessions = await dispatch(env, '/api/sessions', { token: upgradedToken })
    assert(resSessions.status === 200, 'GET /api/sessions succeeds')
    const sessions = await resSessions.json()
    assert(sessions.sessions.some(s => s.id === sessionId), 'guest session preserved after upgrade')

    // Check /api/me reflects upgraded registered quotas
    const resMe = await dispatch(env, '/api/me', { token: upgradedToken })
    const meData = await resMe.json()
    assert(meData.user.isGuest === false, 'isGuest is false in /api/me')
    assert(meData.quota.chatPerDay === 300, 'quota upgraded to standard user chat quota (300)')
  })

  // 10. Admin-email promotion never applies to guests
  await test('10. Admin-email promotion never applies to guests (immune to ADMIN_EMAILS matching)', async () => {
    // Configure ADMIN_EMAILS with wildcard or guest matching pattern
    const promoEnv = makeEnv(db, r2, {
      ADMIN_EMAILS: 'admin@example.com,guest-*,guest-*@guest.invalid,*@guest.invalid',
    })

    const sneakyGuestToken = makeTestToken({
      uid: 'sneaky-anon-guest-42',
      provider: 'anonymous',
    })

    const res = await dispatch(promoEnv, '/api/auth/session', {
      method: 'POST',
      token: sneakyGuestToken,
    })
    assert(res.status === 200, 'session exchange succeeds')
    const data = await res.json()
    assert(data.user.role === 'user', 'role is strictly user, NOT admin')
    assert(data.user.isGuest === true, 'isGuest is true')

    // Attempt admin access with sneaky guest token
    const adminAttempt = await dispatch(promoEnv, '/api/admin/users', { token: sneakyGuestToken })
    assert(adminAttempt.status === 403, 'admin access strictly forbidden for guest')
  })

  // 11. Bonus: Merge-guest endpoint for auth/credential-already-in-use
  await test('11. Merge-guest endpoint (reassigns history to existing account in ONE batch)', async () => {
    // 1. Create a fresh guest user with a conversation
    const mergeGuestUid = 'merge-src-guest-uid'
    const mergeGuestToken = makeTestToken({ uid: mergeGuestUid, provider: 'anonymous' })
    const gRes = await dispatch(env, '/api/auth/session', { method: 'POST', token: mergeGuestToken })
    const gUser = (await gRes.json()).user

    const cRes = await dispatch(env, '/api/chat', {
      method: 'POST',
      token: mergeGuestToken,
      body: { content: 'Message from merge guest', service: 'chatgpt', attachments: [] },
    })
    await cRes.text()

    const gSess = await db.prepare('SELECT * FROM chat_sessions WHERE user_id = ?').bind(gUser.id).first()
    assert(gSess !== null, 'guest session exists')

    // 2. Existing registered user signs in
    const existingUserToken = makeTestToken({
      uid: 'existing-google-user-uid',
      email: 'already.registered@example.com',
      emailVerified: true,
      provider: 'google.com',
    })
    const eRes = await dispatch(env, '/api/auth/session', { method: 'POST', token: existingUserToken })
    const eUser = (await eRes.json()).user

    // 3. Existing user calls /api/auth/merge-guest with guestIdToken
    const mergeRes = await dispatch(env, '/api/auth/merge-guest', {
      method: 'POST',
      token: existingUserToken,
      body: { guestIdToken: mergeGuestToken },
    })
    assert(mergeRes.status === 200, `Expected 200, got ${mergeRes.status}`)
    const mergeData = await mergeRes.json()
    assert(mergeData.merged === true, 'merged is true')

    // 4. Verify guest row is deleted
    const gInDb = await db.prepare('SELECT * FROM users WHERE id = ?').bind(gUser.id).first()
    assert(gInDb === null, 'guest user row deleted')

    // 5. Verify session reassigned to existing user
    const reassignedSess = await db.prepare('SELECT * FROM chat_sessions WHERE id = ?').bind(gSess.id).first()
    assert(reassignedSess.user_id === eUser.id, 'session reassigned to existing user')

    // 6. Existing user's session list includes the merged session
    const listRes = await dispatch(env, '/api/sessions', { token: existingUserToken })
    const listData = await listRes.json()
    assert(listData.sessions.some(s => s.id === gSess.id), 'merged session present in existing user sessions')
  })

  // Restore fetch
  globalThis.fetch = originalFetch

  console.log(`\n======================================================`)
  console.log(`Smoke Test Results: ${passed} passed, ${failed} failed`)
  console.log(`======================================================\n`)

  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
