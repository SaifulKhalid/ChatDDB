#!/usr/bin/env node

/** Active OpenAI-compatible provider-adapter tests. No network or real keys. */

import { OpenAICompatibleAdapter } from '../worker/adapters/openai.ts'
import { ClassifiedUpstreamError } from '../worker/adapters/errors.ts'

let checks = 0
let failures = 0
function check(label, condition) {
  checks++
  if (condition) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}`) }
}

const provider = {
  id: 'provider-1', key: 'agentrouter', label: 'Test gateway', adapter: 'openai',
  base_url: 'https://provider.test/v1/', credentials: '{}',
  headers: '{"X-Provider":"test"}', timeout_ms: 1000, enabled: 1, created_at: 0, updated_at: 0,
}
const request = {
  upstreamModel: 'model-a', messages: [{ role: 'user', content: 'hello' }],
  clientSignal: new AbortController().signal,
  tools: [{ type: 'function', function: { name: 'lookup', description: 'lookup', parameters: { type: 'object' } } }],
  configuration: { tokenParam: 'max_completion_tokens', maxOutputTokens: 42, reasoningEffort: 'low', sendReasoningEffort: true },
}
const adapter = new OpenAICompatibleAdapter()
const originalFetch = globalThis.fetch
function restore() { globalThis.fetch = originalFetch }

try {
  console.log('\nActive provider adapter')
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init }
    return new Response('data: [DONE]\n\n', { status: 200 })
  }
  const response = await adapter.executeChat(provider, { apiKeys: [' key-one ', 'key-two', 'key-one'] }, request)
  const body = JSON.parse(captured.init.body)
  check('uses the active provider route URL', captured.url === 'https://provider.test/v1/chat/completions')
  check('sends the first configured key', captured.init.headers.Authorization === 'Bearer key-one')
  check('preserves configured provider headers', captured.init.headers['X-Provider'] === 'test')
  check('uses the route model and streaming', body.model === 'model-a' && body.stream === true)
  check('uses route-specific token configuration', body.max_completion_tokens === 42 && body.reasoning_effort === 'low')
  check('passes configured tools', body.tools?.[0]?.function?.name === 'lookup' && body.tool_choice === 'auto')
  check('returns a streaming response', response.status === 200 && response.body !== null)

  console.log('\nKey rotation and classification')
  let attempts = 0
  globalThis.fetch = async () => {
    attempts++
    return attempts === 1
      ? new Response(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit' } }), { status: 429 })
      : new Response('data: [DONE]\n\n', { status: 200 })
  }
  const rotated = await adapter.executeChat(provider, { apiKeys: ['one', 'two'] }, request)
  check('rotates to the next key after a rate limit', attempts === 2 && rotated.status === 200)

  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'bad request', type: 'invalid_request' } }), { status: 400 })
  let thrown
  try { await adapter.executeChat(provider, { apiKey: 'one' }, request) } catch (error) { thrown = error }
  check('classifies terminal upstream errors', thrown instanceof ClassifiedUpstreamError && thrown.classification.crossable === false)

  let noKey
  try { await adapter.executeChat(provider, {}, request) } catch (error) { noKey = error }
  check('rejects an unconfigured provider', noKey instanceof ClassifiedUpstreamError && noKey.classification.category === 'not_configured')
} finally {
  restore()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exitCode = failures === 0 ? 0 : 1
