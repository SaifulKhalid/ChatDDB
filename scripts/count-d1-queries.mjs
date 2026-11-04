/**
 * Script to trace and count exact D1 queries during a standard POST /api/chat invocation.
 */
import { resolveService, resolveEligibleRoutes } from '../worker/orchestrator.ts'
import * as ratelimit from '../worker/lib/ratelimit.ts'
import * as sessionsDb from '../worker/db/sessions.ts'
import * as messagesDb from '../worker/db/messages.ts'
import * as activity from '../worker/db/activity.ts'
import { batch } from '../worker/db/client.ts'

function createTracedDb() {
  const queries = []

  const makeStmt = (sql, params = []) => ({
    bind(...newParams) {
      return makeStmt(sql, newParams)
    },
    async first() {
      queries.push({ type: 'first', sql: sql.trim(), params })
      if (sql.includes('FROM ai_services WHERE key =')) {
        return { id: 'srv-chatgpt', key: 'chatgpt', public_name: 'ChatGPT', capabilities: '{}', enabled: 1, default_service: 0 }
      }
      if (sql.includes('FROM ai_routes r')) {
        return { n: 1 }
      }
      if (sql.includes('FROM rate_counters WHERE key =')) {
        return { count: 1, reset_at: Date.now() + 60000 }
      }
      if (sql.includes('FROM chat_sessions WHERE id =')) {
        return { id: 'test-session-id', user_id: 'user-1', model: 'ChatGPT' }
      }
      if (sql.includes('FROM chat_messages WHERE session_id =')) {
        return null
      }
      return {}
    },
    async all() {
      queries.push({ type: 'all', sql: sql.trim(), params })
      if (sql.includes('FROM ai_services')) {
        return { results: [{ id: 'srv-chatgpt', key: 'chatgpt', public_name: 'ChatGPT', capabilities: '{}', enabled: 1 }] }
      }
      if (sql.includes('FROM ai_routes')) {
        return { results: [{ id: 'rt-1', service_id: 'srv-chatgpt', provider_id: 'prov-1', upstream_model_id: 'gpt-5.6-sol', priority: 1, weight: 100, enabled: 1 }] }
      }
      if (sql.includes('FROM api_providers')) {
        return { results: [{ id: 'prov-1', key: 'agentrouter', label: 'AgentRouter', adapter: 'openai', base_url: 'https://agentrouter.org/v1', credentials: '{}', enabled: 1 }] }
      }
      if (sql.includes('FROM route_health')) {
        return { results: [] }
      }
      if (sql.includes('FROM chat_messages WHERE session_id =')) {
        return { results: [] }
      }
      return { results: [] }
    },
    async run() {
      queries.push({ type: 'run', sql: sql.trim(), params })
      return { success: true }
    }
  })

  const db = {
    prepare(sql) {
      return makeStmt(sql)
    },
    async batch(stmts) {
      queries.push({ type: 'batch', count: stmts.length, sql: 'batch: ' + stmts.length + ' statements' })
      return stmts.map(() => ({ success: true }))
    }
  }

  return { db, queries }
}

async function runTrace() {
  const { db, queries } = createTracedDb()
  const env = { AGENTROUTER_API_KEY: 'test-key' }

  console.log('--- Tracing D1 Queries for POST /api/chat ---')

  // Step 1: postChat resolveService
  const service = await resolveService(db, env, 'chatgpt', { content: 'hello' })

  // Step 2: limitChat (rate limit check)
  await ratelimit.consume(db, 'user:user-1', 'chat', [
    { kind: 'minute', max: 60 },
    { kind: 'day', max: 500 },
  ])

  // Step 3: resolveSession
  const _session = await sessionsDb.getOwned(db, 'test-session-id', 'user-1')

  // Step 4: prepareTurn history read
  const _history = await messagesDb.historyFor(db, 'test-session-id', 20, 200000)

  // Step 5: prepareTurn batch message insert
  const inserted = messagesDb.insertStmt({
    sessionId: 'test-session-id',
    userId: 'user-1',
    role: 'user',
    content: 'hello',
    model: service.public_name,
    modelProvider: null,
    attachmentCount: 0,
    createdAt: Date.now(),
  })
  const statements = [
    inserted.stmt,
    sessionsDb.touchStmt('test-session-id', 1, service.public_name, Date.now()),
    activity.logStmt({
      userId: 'user-1',
      action: 'message_sent',
      metadata: { sessionId: 'test-session-id', model: service.public_name, chars: 5, attachments: 0, promptHash: 'abc' },
      ipHash: 'ip',
      userAgent: 'agent',
    }),
  ]
  await batch(db, statements)

  // Step 6: orchestrateChat (duplicate resolveService + route resolution)
  await resolveService(db, env, service.key, { content: 'hello' })
  const _candidates = await resolveEligibleRoutes(db, service.id, {})

  console.log(`\nTotal D1 queries/operations on critical path: ${queries.length}\n`)
  queries.forEach((q, i) => {
    console.log(`  ${i + 1}. [${q.type}] ${q.sql.slice(0, 90).replace(/\n/g, ' ')}...`)
  })
}

runTrace().catch(console.error)
