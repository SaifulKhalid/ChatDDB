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

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
