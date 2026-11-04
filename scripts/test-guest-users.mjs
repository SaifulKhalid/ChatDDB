#!/usr/bin/env node

/**
 * Unit tests for guest user DB operations (upsertOnLogin, admin email immunity, reconciliation isolation).
 *
 * Usage:
 *   node --experimental-strip-types scripts/test-guest-users.mjs
 */

import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { upsertOnLogin, findByFirebaseUid, findById } from '../worker/db/users.ts'
import { cleanupExpiredGuests } from '../worker/cron/cleanup.ts'
import * as activity from '../worker/db/activity.ts'
import { forbidden } from '../worker/lib/http.ts'

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

/** Creates a mock D1Database backed by in-memory SQLite */
function createMockD1() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON;')

  // Apply migrations 0001 and 0009
  const m1 = readFileSync(resolve('migrations/0001_users_and_activity.sql'), 'utf-8')
  sqlite.exec(m1)

  const m9 = readFileSync(resolve('migrations/0009_guest_mode.sql'), 'utf-8')
  sqlite.exec(m9)

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

async function main() {
  console.log('Guest User DB & Auth Unit Tests')

  await test('Anonymous token creates a new guest user with is_guest=1 and synthetic email', async () => {
    const db = createMockD1()
    const token = {
      uid: 'anon-uid-1',
      email: '',
      emailVerified: false,
      isAnonymous: true,
    }

    const res = await upsertOnLogin(db, token, ['admin@example.com'])
    assert(res.user.firebase_uid === 'anon-uid-1', 'firebase_uid matches')
    assert(res.user.is_guest === 1, 'is_guest is 1')
    assert(res.user.role === 'user', 'role is user')
    assert(res.user.name === 'Guest', 'name is Guest')
    assert(res.user.email === `guest-${res.user.id}@guest.invalid`, 'synthetic email matches pattern')
    assert(res.user.login_count === 1, 'login_count is 1')
    assert(!res.reconciledFrom, 'reconciledFrom is undefined')

    const inDb = await findByFirebaseUid(db, 'anon-uid-1')
    assert(inDb !== null, 'user exists in db')
    assert(inDb.is_guest === 1, 'inDb.is_guest is 1')
  })

  await test('Existing guest logs in again: uid matched, login_count incremented, role stays user', async () => {
    const db = createMockD1()
    const token = {
      uid: 'anon-uid-2',
      email: '',
      emailVerified: false,
      isAnonymous: true,
    }

    const first = await upsertOnLogin(db, token, [])
    const second = await upsertOnLogin(db, token, [])

    assert(second.user.id === first.user.id, 'user id unchanged')
    assert(second.user.login_count === 2, 'login_count incremented to 2')
    assert(second.user.is_guest === 1, 'is_guest is 1')
    assert(second.user.role === 'user', 'role is user')
  })

  await test('Guest is NEVER matched against ADMIN_EMAILS and role is forced to user', async () => {
    const db = createMockD1()
    const token = {
      uid: 'anon-uid-3',
      email: '',
      emailVerified: false,
      isAnonymous: true,
    }

    // Try passing wildcard / synthetic email / anything in adminEmails
    const adminEmails = ['*', '', 'guest@guest.invalid', 'guest-anon-uid-3@guest.invalid']
    const res = await upsertOnLogin(db, token, adminEmails)
    assert(res.user.role === 'user', 'role must strictly be user')

    // Second login with explicit synthetic email in adminEmails
    const adminEmails2 = [res.user.email]
    const res2 = await upsertOnLogin(db, token, adminEmails2)
    assert(res2.user.role === 'user', 'role must strictly remain user even if adminEmails lists the synthetic email')
  })

  await test('Guests NEVER take part in verified-email row adoption/reconciliation', async () => {
    const db = createMockD1()

    // Create a regular verified user
    const userToken = {
      uid: 'google-uid-1',
      email: 'alice@example.com',
      emailVerified: true,
      isAnonymous: false,
      name: 'Alice',
    }
    const regularUser = await upsertOnLogin(db, userToken, [])
    assert(regularUser.user.is_guest === 0, 'regular user is_guest is 0')

    // Guest login with anonymous token
    const guestToken = {
      uid: 'anon-uid-4',
      email: '',
      emailVerified: false,
      isAnonymous: true,
    }
    const guest = await upsertOnLogin(db, guestToken, [])
    assert(guest.user.id !== regularUser.user.id, 'guest gets distinct id')
    assert(guest.user.is_guest === 1, 'guest is_guest is 1')
    assert(!guest.reconciledFrom, 'guest cannot be reconciled')

    // Verify alice is untouched
    const aliceInDb = await findById(db, regularUser.user.id)
    assert(aliceInDb.firebase_uid === 'google-uid-1', 'alice firebase_uid unchanged')
    assert(aliceInDb.email === 'alice@example.com', 'alice email unchanged')
  })

  await test('Upgrading guest: linkWithPopup keeps same uid, updates email/name, sets is_guest=0', async () => {
    const db = createMockD1()
    const guestUid = 'shared-uid-1'

    // Step 1: initial guest login
    const guestToken = {
      uid: guestUid,
      email: '',
      emailVerified: false,
      isAnonymous: true,
    }
    const guestRes = await upsertOnLogin(db, guestToken, [])
    assert(guestRes.user.is_guest === 1, 'is_guest is 1')

    // Step 2: user linked Google account (same uid, but now Google provider with real email)
    const linkedToken = {
      uid: guestUid,
      email: 'bob@example.com',
      emailVerified: true,
      isAnonymous: false,
      name: 'Bob',
    }
    const linkedRes = await upsertOnLogin(db, linkedToken, ['bob@example.com'])
    assert(linkedRes.user.id === guestRes.user.id, 'same user row preserved')
    assert(linkedRes.user.is_guest === 0, 'is_guest updated to 0')
    assert(linkedRes.user.email === 'bob@example.com', 'email updated to real email')
    assert(linkedRes.user.name === 'Bob', 'name updated to Bob')
    assert(linkedRes.user.role === 'admin', 'promoted to admin if listed in ADMIN_EMAILS')
  })

  await test('cleanupExpiredGuests deletes R2 objects and expired guest rows, preserving active guests and registered users', async () => {
    const db = createMockD1()
    const now = Date.now()
    const dayMs = 86_400_000

    // Setup chat_sessions and files tables so cascade and FKs work
    await db.prepare(`CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`).run()

    await db.prepare(`CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      file_type TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      r2_key TEXT NOT NULL UNIQUE,
      extracted_text_key TEXT,
      upload_status TEXT NOT NULL DEFAULT 'stored',
      created_at INTEGER NOT NULL
    )`).run()

    // 1. Expired guest (40 days old)
    const expiredGuest = await upsertOnLogin(db, {
      uid: 'expired-guest',
      email: '',
      emailVerified: false,
      isAnonymous: true,
    }, [])
    await db.prepare('UPDATE users SET last_login = ? WHERE id = ?')
      .bind(now - 40 * dayMs, expiredGuest.user.id).run()

    // Add a file for expired guest
    await db.prepare(`INSERT INTO files (id, user_id, filename, original_filename, file_type, mime_type, file_size, r2_key, extracted_text_key, upload_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind('f-1', expiredGuest.user.id, 'pic.png', 'pic.png', 'image', 'image/png', 100, 'r2-key-1', 'r2-text-1', 'stored', now - 40 * dayMs)
      .run()

    // Add activity log for expired guest
    await db.prepare(`INSERT INTO activity_logs (id, user_id, action, timestamp) VALUES (?, ?, ?, ?)`)
      .bind('act-1', expiredGuest.user.id, 'guest_login', now - 40 * dayMs).run()

    // 2. Active guest (5 days old)
    const activeGuest = await upsertOnLogin(db, {
      uid: 'active-guest',
      email: '',
      emailVerified: false,
      isAnonymous: true,
    }, [])
    await db.prepare('UPDATE users SET last_login = ? WHERE id = ?')
      .bind(now - 5 * dayMs, activeGuest.user.id).run()

    // 3. Registered user (40 days old)
    const regUser = await upsertOnLogin(db, {
      uid: 'reg-user',
      email: 'carol@example.com',
      emailVerified: true,
      isAnonymous: false,
    }, [])
    await db.prepare('UPDATE users SET last_login = ? WHERE id = ?')
      .bind(now - 40 * dayMs, regUser.user.id).run()

    // Mock R2 bucket
    const deletedR2 = []
    const mockBucket = {
      async delete(key) {
        deletedR2.push(key)
      },
    }

    const res = await cleanupExpiredGuests(db, mockBucket, 30, now)
    assert(res.expiredGuests === 1, 'cleaned up exactly 1 expired guest')
    assert(res.deletedFiles === 1, 'tracked 1 deleted file')

    // Verify R2 deletion
    assert(deletedR2.includes('r2-key-1'), 'r2_key was deleted from R2')
    assert(deletedR2.includes('r2-text-1'), 'extracted_text_key was deleted from R2')

    // Verify DB states
    const expiredInDb = await findById(db, expiredGuest.user.id)
    assert(expiredInDb === null, 'expired guest row is deleted')

    const fileInDb = await db.prepare('SELECT * FROM files WHERE id = ?').bind('f-1').first()
    assert(fileInDb === null, 'file row deleted via cascade')

    const actInDb = await db.prepare('SELECT user_id FROM activity_logs WHERE id = ?').bind('act-1').first()
    assert(actInDb.user_id === null, 'activity log preserved with user_id NULL via SET NULL')

    const activeInDb = await findById(db, activeGuest.user.id)
    assert(activeInDb !== null, 'active guest is preserved')

    const regInDb = await findById(db, regUser.user.id)
    assert(regInDb !== null, 'registered user is preserved even if older than retention')
  })

  await test('Guest access to admin routes is rejected with 403 admin_required and logged as suspicious_activity', async () => {
    const db = createMockD1()

    // Create guest user
    const guest = await upsertOnLogin(db, {
      uid: 'guest-admin-probe',
      email: '',
      emailVerified: false,
      isAnonymous: true,
    }, [])

    assert(guest.user.role === 'user', 'guest has user role')
    assert(guest.user.is_guest === 1, 'guest is_guest is 1')

    // Simulate requireAdmin logic with guest authed context
    let rejected = false
    try {
      if (guest.user.role !== 'admin') {
        await activity.log(db, {
          userId: guest.user.id,
          action: 'suspicious_activity',
          severity: 'warn',
          metadata: { reason: 'admin_route_denied', path: '/api/admin/users' },
          ipHash: 'test-ip-hash',
          userAgent: 'test-agent',
        })
        throw forbidden('Administrator access is required.', 'admin_required')
      }
    } catch (err) {
      assert(err.status === 403, 'status is 403')
      assert(err.type === 'admin_required', 'type is admin_required')
      rejected = true
    }
    assert(rejected, 'guest was rejected')

    // Verify suspicious_activity log was recorded
    const logs = await db.prepare("SELECT * FROM activity_logs WHERE user_id = ? AND action = 'suspicious_activity'")
      .bind(guest.user.id).all()
    assert(logs.results.length === 1, 'suspicious_activity was logged for guest')
    const log = logs.results[0]
    assert(log.user_id === guest.user.id, 'log user_id matches guest')
    const meta = JSON.parse(log.metadata)
    assert(meta.reason === 'admin_route_denied', 'reason is admin_route_denied')
  })

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
