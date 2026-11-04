#!/usr/bin/env node

/** Active two-provider upstream client tests. No network or real keys. */

import { callUpstream } from '../worker/routing.ts'
import { PROVIDERS } from '../worker/catalog.ts'
import { ClassifiedUpstreamError } from '../worker/adapters/errors.ts'

let checks = 0
let failures = 0
function check(label, condition) {
  checks++
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}`)
  }
}

const originalFetch = globalThis.fetch
function restore() {
  globalThis.fetch = originalFetch
}

try {
  console.log('\nActive provider: AgentRouter (Responses API)')
  let captured = null
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init }
    return new Response('event: response.output_item.added\ndata: {}\n\n', { status: 200 })
  }

  const target = { provider: 'agentrouter', upstreamModel: 'gpt-6.1-sol' }
  const request = {
    messages: [{ role: 'user', content: 'hello' }],
    clientSignal: new AbortController().signal,
    tools: [
      {
        type: 'function',
        function: { name: 'lookup', description: 'lookup', parameters: { type: 'object' } },
      },
    ],
  }

  const res = await callUpstream(target, PROVIDERS.agentrouter, ['key-one', 'key-two'], request)
  const body = JSON.parse(captured.init.body)

  check('uses responses endpoint for agentrouter', captured.url === 'https://agentrouter.org/v1/responses')
  check('sends bearer auth header', captured.init.headers.Authorization === 'Bearer key-one')
  check('sends mandatory codex_cli_rs user-agent', captured.init.headers['User-Agent'] === 'codex_cli_rs/0.40.0')
  check('formats input messages for responses API', Array.isArray(body.input) && body.input[0].content === 'hello')
  check('passes upstream model and stream flag', body.model === 'gpt-6.1-sol' && body.stream === true)
  check('returns ok response', res.res.status === 200)

  console.log('\nActive provider: ApiNex (Chat Completions API)')
  captured = null
  const apinexTarget = { provider: 'apinex', upstreamModel: 'free/gpt-6-luna' }
  await callUpstream(apinexTarget, PROVIDERS.apinex, ['key-apinex'], request)
  const apinexBody = JSON.parse(captured.init.body)

  check('uses chat/completions endpoint for apinex', captured.url === 'https://api.apinex.bond/v1/chat/completions')
  check('formats messages for chat completions API', Array.isArray(apinexBody.messages) && apinexBody.messages[0].content === 'hello')
  check('passes tools in chat completions', apinexBody.tools?.[0]?.function?.name === 'lookup')

  console.log('\nKey rotation and classification')
  let attempts = 0
  globalThis.fetch = async () => {
    attempts++
    return attempts === 1
      ? new Response(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit' } }), { status: 429 })
      : new Response('data: [DONE]\n\n', { status: 200 })
  }

  const rotated = await callUpstream(target, PROVIDERS.agentrouter, ['one', 'two'], request)
  check('rotates to next key on 429', attempts === 2 && rotated.res.status === 200)

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'bad request', type: 'invalid_request' } }), { status: 400 })
  let thrown
  try {
    await callUpstream(target, PROVIDERS.agentrouter, ['one'], request)
  } catch (error) {
    thrown = error
  }
  check('classifies terminal 4xx upstream errors as non-crossable', thrown instanceof ClassifiedUpstreamError && thrown.classification.crossable === false)

  let noKey
  try {
    await callUpstream(target, PROVIDERS.agentrouter, [], request)
  } catch (error) {
    noKey = error
  }
  check('rejects unconfigured provider without keys', noKey instanceof ClassifiedUpstreamError && noKey.classification.category === 'not_configured')
} finally {
  restore()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exitCode = failures === 0 ? 0 : 1
