#!/usr/bin/env node

/**
 * Unit test for AI Routing & Catalog core logic:
 * - Error classification (transient vs terminal, crossable vs non-crossable)
 * - Safe message sanitization (no internal model/provider leakage)
 * - Static catalogue resolution & fallback ladder definition
 * - In-memory circuit breaker behavior
 * - Public model key mapping
 */

import { strict as assert } from 'assert'
import { classifyHttpResponse, classifyNetworkError } from '../worker/adapters/errors.ts'
import { MODELS, PROVIDERS, resolveModel } from '../worker/catalog.ts'
import { getCircuitBreakerStatus } from '../worker/routing.ts'
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
console.log('AI Routing & Catalog Core Unit Tests')
console.log('======================================================\n')

// 1. Error Classification & Sanitization Tests
test('classifyHttpResponse: 429 Rate Limit is crossable with sanitized message', () => {
  const classified = classifyHttpResponse(
    429,
    { message: 'Rate limit exceeded on upstream model gpt-6.1-sol' },
    'ChatGPT',
    'AgentRouter',
    'gpt-6.1-sol',
    '30',
  )
  assert.equal(classified.crossable, true)
  assert.equal(classified.publicStatus, 429)
  assert.equal(classified.category, 'rate_limited')
  assert.equal(classified.retryAfterSeconds, 30)
  // Strict sanitization: must NEVER contain upstream model or provider name
  assert(!classified.publicMessage.includes('gpt-6.1-sol'), 'Should not contain model ID')
  assert(!classified.publicMessage.includes('AgentRouter'), 'Should not contain provider name')
  assert(classified.publicMessage.includes('ChatGPT'), 'Should reference public service name')
})

test('classifyHttpResponse: 502/503 Gateway Error is crossable', () => {
  const classified = classifyHttpResponse(
    502,
    { message: 'Bad Gateway from agentrouter.org/v1' },
    'ChatGPT',
    'AgentRouter',
    'gpt-6.1-sol',
  )
  assert.equal(classified.crossable, true)
  assert.equal(classified.publicStatus, 502)
  assert.equal(classified.category, 'upstream_server_error')
  assert(!classified.publicMessage.includes('agentrouter'), 'Should not leak upstream domain')
  assert(!classified.publicMessage.includes('gpt-6.1-sol'), 'Should not leak model ID')
})

test('classifyHttpResponse: 400 Bad Request is NOT crossable (client issue)', () => {
  const classified = classifyHttpResponse(
    400,
    { message: 'Invalid format' },
    'ChatGPT',
    'ApiNex',
    'free/gpt-6-luna',
  )
  assert.equal(classified.crossable, false)
  assert.equal(classified.publicStatus, 400)
  assert.equal(classified.category, 'bad_request')
})

test('classifyHttpResponse: 401 Insufficient Quota is crossable to backup provider', () => {
  const classified = classifyHttpResponse(
    401,
    { message: 'insufficient_user_quota: please recharge balance' },
    'ChatGPT',
    'AgentRouter',
    'gpt-6.1-sol',
  )
  assert.equal(classified.crossable, true)
  assert.equal(classified.category, 'quota_exhausted')
})

test('classifyNetworkError: Abort / Timeout is crossable', () => {
  const timeoutErr = new Error('The operation was aborted due to timeout')
  timeoutErr.name = 'TimeoutError'
  const classified = classifyNetworkError(timeoutErr, 'ChatGPT', 'AgentRouter', 'gpt-6.1-sol')
  assert.equal(classified.crossable, true)
  assert.equal(classified.category, 'timeout')
  assert.equal(classified.publicStatus, 504)
  assert(!classified.publicMessage.includes('AgentRouter'))
})

// 2. Static Catalogue Tests
test('catalog: exactly two providers configured (AgentRouter & ApiNex)', () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ['agentrouter', 'apinex'])
  assert.equal(PROVIDERS.agentrouter.protocol, 'responses')
  assert.equal(PROVIDERS.apinex.protocol, 'chat_completions')
})

test('catalog: resolveModel resolves default and aliases', () => {
  const defaultModel = resolveModel()
  assert.equal(defaultModel.key, 'chatgpt')
  assert.ok(defaultModel.targets.length >= 2, 'Default model has primary and fallback targets')

  const byAlias = resolveModel('gpt-5.6-sol')
  assert.equal(byAlias.key, 'chatgpt')

  const auto = resolveModel('auto')
  assert.equal(auto.key, 'chatgpt')
})

test('catalog: models define fallback targets across the two providers', () => {
  for (const model of MODELS) {
    assert.ok(model.targets.length >= 1)
    for (const tgt of model.targets) {
      assert.ok(tgt.provider === 'agentrouter' || tgt.provider === 'apinex')
      assert.ok(tgt.upstreamModel.length > 0)
    }
  }
})

// 3. Circuit Breaker & Health Tests
test('circuit breaker: getCircuitBreakerStatus returns object', () => {
  const status = getCircuitBreakerStatus()
  assert.equal(typeof status, 'object')
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

test('toPublicModelKey: passes through every seeded public name unchanged', () => {
  for (const name of ['ChatGPT', 'Gemini', 'Claude', 'DeepSeek', 'GLM', 'Grok']) {
    assert.equal(toPublicModelKey(name), name)
  }
})

test('toPublicModelKey: anchors on a prefix, so "sol" no longer means ChatGPT', () => {
  assert.equal(toPublicModelKey('solar-10.7b'), null)
  assert.equal(toPublicModelKey('console-preview'), null)
  assert.equal(toPublicModelKey('my-gpt-clone'), null)
  assert.equal(toPublicModelKey('not-a-claude-model'), null)
})

test('toPublicModelKey: never leaks an image vendor or model id', () => {
  assert.equal(toPublicModelKey('@cf/black-forest-labs/flux-1-schnell'), 'Image')
  assert.equal(toPublicModelKey('pollinations/flux'), 'Image')
  assert.equal(toPublicModelKey('pollinations/turbo'), 'Image')
})

test('toPublicModelKey: withholds anything it cannot classify', () => {
  assert.equal(toPublicModelKey('some-unreleased-model-v9'), null)
  assert.equal(toPublicModelKey('gpt'), null)
  assert.equal(toPublicModelKey(undefined), undefined)
  assert.equal(toPublicModelKey(''), '')
})

console.log(`\n======================================================`)
console.log(`Results: ${passed} passed, ${failed} failed`)
console.log(`======================================================\n`)

if (failed > 0) process.exit(1)
