#!/usr/bin/env node

/**
 * Unit test for AI Routing core logic:
 * - Error classification (transient vs terminal, crossable vs non-crossable)
 * - Safe message sanitization (no internal model/provider leakage)
 * - Service health status computation (operational, degraded, down)
 * - Credential masking (••••••••1234)
 * - Public model key mapping
 */

import { strict as assert } from 'assert'
import { classifyHttpResponse, classifyNetworkError } from '../worker/adapters/errors.ts'
import { computeServiceStatus, maskCredentialsJson } from '../worker/db/aiRouting.ts'
import { toPublicModelKey } from '../worker/db/messages.ts'

let passed = 0
let failed = 0

function test(label, fn) {
  try {
    fn()
    console.log(`  ✓ ${label}`)
    passed++
  } catch (err) {
    console.log(`  ✗ ${label}: ${err.message}`)
    failed++
  }
}

console.log('\n======================================================')
console.log('AI Routing Core Unit Tests')
console.log('======================================================\n')

// 1. Error Classification & Sanitization Tests
test('classifyHttpResponse: 429 Rate Limit is crossable with sanitized message', () => {
  const classified = classifyHttpResponse(
    429,
    { message: 'Rate limit exceeded on upstream model gpt-5.6-sol' },
    'ChatGPT',
    'CodeCraft',
    'gpt-5.6-sol',
    '30',
  )
  assert.equal(classified.crossable, true)
  assert.equal(classified.publicStatus, 429)
  assert.equal(classified.category, 'rate_limited')
  assert.equal(classified.retryAfterSeconds, 30)
  // Strict sanitization: must NEVER contain upstream model or provider name
  assert(!classified.publicMessage.includes('gpt-5.6-sol'), 'Should not contain model ID')
  assert(!classified.publicMessage.includes('CodeCraft'), 'Should not contain provider name')
  assert(classified.publicMessage.includes('ChatGPT'), 'Should reference public service name')
})

test('classifyHttpResponse: 502/503 Gateway Error is crossable', () => {
  const classified = classifyHttpResponse(
    502,
    { message: 'Bad Gateway from agentrouter.org/v1' },
    'DeepSeek',
    'AgentRouter',
    'deepseek-v4-flash',
  )
  assert.equal(classified.crossable, true)
  assert.equal(classified.publicStatus, 502)
  assert.equal(classified.category, 'upstream_server_error')
  assert(!classified.publicMessage.includes('agentrouter'), 'Should not leak upstream domain')
  assert(!classified.publicMessage.includes('deepseek-v4-flash'), 'Should not leak model ID')
})

test('classifyHttpResponse: 400 Bad Request is NOT crossable (client issue)', () => {
  const classified = classifyHttpResponse(
    400,
    { message: 'Invalid format' },
    'Gemini',
    'CodeCraft',
    'gemini-3.7-flash',
  )
  assert.equal(classified.crossable, false)
  assert.equal(classified.publicStatus, 400)
  assert.equal(classified.category, 'bad_request')
})

test('classifyHttpResponse: 401 Insufficient Quota is crossable to backup provider', () => {
  const classified = classifyHttpResponse(
    401,
    { message: 'insufficient_user_quota: please recharge balance' },
    'Claude',
    'CodeCraft',
    'claude-opus-5',
  )
  assert.equal(classified.crossable, true)
  assert.equal(classified.category, 'quota_exhausted')
})

test('classifyNetworkError: Abort / Timeout is crossable', () => {
  const timeoutErr = new Error('The operation was aborted due to timeout')
  timeoutErr.name = 'TimeoutError'
  const classified = classifyNetworkError(timeoutErr, 'Grok', 'AgentRouter', 'gpt-5.6-sol')
  assert.equal(classified.crossable, true)
  assert.equal(classified.category, 'timeout')
  assert.equal(classified.publicStatus, 504)
  assert(!classified.publicMessage.includes('AgentRouter'))
})

// 2. Secret Masking Tests
test('maskCredentialsJson: safely masks API keys (••••••••1234)', () => {
  const jsonWithKey = JSON.stringify({ apiKey: 'sk-proj-9876543210abcdef' })
  const { maskedKey, hasKey } = maskCredentialsJson(jsonWithKey)
  assert.equal(hasKey, true)
  assert.equal(maskedKey, '••••••••cdef')

  const jsonEmpty = JSON.stringify({})
  const emptyRes = maskCredentialsJson(jsonEmpty)
  assert.equal(emptyRes.hasKey, false)
  assert.equal(emptyRes.maskedKey, '')
})

// 3. Service Status Computation Tests
test('computeServiceStatus: operational when P1 is healthy', () => {
  const status = computeServiceStatus([
    { enabled: 1, priority: 1, health: { consecutive_failures: 0, circuit_until: null } },
    { enabled: 1, priority: 2, health: { consecutive_failures: 0, circuit_until: null } },
  ])
  assert.equal(status, 'operational')
})

test('computeServiceStatus: degraded when P1 is failing or circuit broken but P2 is operational', () => {
  const status = computeServiceStatus([
    { enabled: 1, priority: 1, health: { consecutive_failures: 3, circuit_until: Date.now() + 60000 } },
    { enabled: 1, priority: 2, health: { consecutive_failures: 0, circuit_until: null } },
  ])
  assert.equal(status, 'degraded')
})

test('computeServiceStatus: down when all routes have broken circuits', () => {
  const status = computeServiceStatus([
    { enabled: 1, priority: 1, health: { consecutive_failures: 3, circuit_until: Date.now() + 60000 } },
    { enabled: 1, priority: 2, health: { consecutive_failures: 3, circuit_until: Date.now() + 60000 } },
  ])
  assert.equal(status, 'down')
})

// 4. Public Model Key Mapping Tests
test('toPublicModelKey: maps internal IDs to clean public names', () => {
  assert.equal(toPublicModelKey('gpt-5.6-sol'), 'ChatGPT')
  assert.equal(toPublicModelKey('deepseek-v4-flash'), 'DeepSeek')
  assert.equal(toPublicModelKey('gemini-3.7-flash'), 'Gemini')
  assert.equal(toPublicModelKey('claude-opus-5'), 'Claude')
  assert.equal(toPublicModelKey('glm-5.3'), 'GLM')
  assert.equal(toPublicModelKey('ChatGPT'), 'ChatGPT')
  assert.equal(toPublicModelKey(null), null)
})

console.log(`\n======================================================`)
console.log(`Results: ${passed} passed, ${failed} failed`)
console.log(`======================================================\n`)

if (failed > 0) process.exit(1)
