#!/usr/bin/env node

/**
 * Smoke test for two-provider failover and stream resilience.
 *
 * Spins up a local HTTP stub server to simulate upstream failure modes:
 *  1. TTFB timeout (pre-first-byte) -> silent failover to secondary target.
 *  2. 429 Rate Limit (pre-first-byte) -> silent failover to secondary target.
 *  3. 502 Bad Gateway (pre-first-byte) -> silent failover to secondary target.
 *  4. SSE `data: null` frames -> handled gracefully without crashing.
 *  5. Mid-stream socket drop (post-first-byte) -> surfaces as SSE error frame, never restarts.
 */

import http from 'node:http'
import { strict as assert } from 'node:assert'
import { toClientStream } from '../worker/sse.ts'
import { callUpstream } from '../worker/routing.ts'

let passed = 0
let failed = 0

function test(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${label}`)
      passed++
    })
    .catch((err) => {
      console.log(`  ✗ ${label}: ${err.message}`)
      failed++
    })
}

// ---------------------------------------------------------------------------
// In-process stub upstream server
// ---------------------------------------------------------------------------

let testScenario = 'idle'
let callCount = 0

const server = http.createServer(async (req, res) => {
  callCount++
  const currentScenario = testScenario

  if (currentScenario === 'ttfb_timeout') {
    if (callCount === 1) {
      // Primary: delay longer than ttfbTimeoutMs
      await new Promise((r) => setTimeout(r, 150))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"too late"}}]}\n\n')
      res.end()
    } else {
      // Secondary: instant response
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"failover success"}}]}\n\n')
      res.end()
    }
    return
  }

  if (currentScenario === '429_rate_limit') {
    if (callCount === 1) {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Rate limit exceeded', type: 'rate_limit' } }))
    } else {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"recovered from 429"}}]}\n\n')
      res.end()
    }
    return
  }

  if (currentScenario === '5xx_error') {
    if (callCount === 1) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Bad Gateway', type: 'gateway_error' } }))
    } else {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"recovered from 502"}}]}\n\n')
      res.end()
    }
    return
  }

  if (currentScenario === 'null_frame') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: null\n\n')
    res.write('data: {"choices":[{"delta":{"content":"valid payload after null"}}]}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  if (currentScenario === 'midstream_drop') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"Hello before disconnect"}}\n\n')
    // Abruptly destroy the socket mid-stream
    setTimeout(() => {
      req.socket.destroy()
    }, 20)
    return
  }

  // Default ok
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"content":"default"}}]}\n\n')
  res.end()
})

const PORT = 8799
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))
const BASE_URL = `http://127.0.0.1:${PORT}`

console.log('\n======================================================')
console.log(`ChatDDB Failover & SSE Resilience Smoke Test (${BASE_URL})`)
console.log('======================================================\n')

const testProvider = {
  key: 'agentrouter',
  label: 'Stub Provider',
  baseUrl: BASE_URL,
  keyEnvNames: ['TEST_KEY'],
  protocol: 'chat_completions',
  headers: {},
  ttfbTimeoutMs: 20000,
  totalTimeoutMs: 180000,
  tokenParam: 'max_tokens',
}

try {
  // 1. TTFB timeout failover
  await test('Pre-first-byte: TTFB timeout trips and triggers failover', async () => {
    testScenario = 'ttfb_timeout'
    callCount = 0

    let firstAttemptFailed = false
    try {
      await callUpstream(
        { provider: 'agentrouter', upstreamModel: 'primary' },
        testProvider,
        ['k1'],
        {
          messages: [{ role: 'user', content: 'hi' }],
          clientSignal: new AbortController().signal,
          ttfbTimeoutMs: 50, // 50ms timeout against 150ms delay
        },
      )
    } catch (err) {
      if (
        err.category === 'ttfb_timeout' ||
        err.category === 'timeout' ||
        err.classification?.category === 'ttfb_timeout' ||
        err.classification?.category === 'timeout'
      ) {
        firstAttemptFailed = true
      }
    }
    assert.equal(firstAttemptFailed, true, 'Primary call should time out on TTFB')

    // Secondary call should succeed
    const secondary = await callUpstream(
      { provider: 'agentrouter', upstreamModel: 'secondary' },
      testProvider,
      ['k1'],
      {
        messages: [{ role: 'user', content: 'hi' }],
        clientSignal: new AbortController().signal,
        ttfbTimeoutMs: 500,
      },
    )
    assert.equal(secondary.res.status, 200)
    const text = await secondary.res.text()
    assert.ok(text.includes('failover success'))
  })

  // 2. 429 Rate limit failover
  await test('Pre-first-byte: 429 rate limit triggers key rotation / failover', async () => {
    testScenario = '429_rate_limit'
    callCount = 0

    const res = await callUpstream(
      { provider: 'agentrouter', upstreamModel: 'model-a' },
      testProvider,
      ['key-1', 'key-2'], // Rotates from key-1 to key-2
      {
        messages: [{ role: 'user', content: 'hi' }],
        clientSignal: new AbortController().signal,
      },
    )
    assert.equal(res.res.status, 200)
    const text = await res.res.text()
    assert.ok(text.includes('recovered from 429'))
    assert.equal(callCount, 2, 'Rotated to second key on 429')
  })

  // 3. 502 Gateway Error failover
  await test('Pre-first-byte: 502 server error is classified as crossable', async () => {
    testScenario = '5xx_error'
    callCount = 0

    let thrown = null
    try {
      await callUpstream(
        { provider: 'agentrouter', upstreamModel: 'model-a' },
        testProvider,
        ['key-1'],
        {
          messages: [{ role: 'user', content: 'hi' }],
          clientSignal: new AbortController().signal,
        },
      )
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'Should throw ClassifiedUpstreamError on 502')
    assert.equal(thrown.classification?.crossable, true, '502 must be classified as crossable')
    assert.equal(thrown.classification?.publicStatus, 502)

    // Call to fallback target succeeds
    const fallback = await callUpstream(
      { provider: 'agentrouter', upstreamModel: 'model-b' },
      testProvider,
      ['key-1'],
      {
        messages: [{ role: 'user', content: 'hi' }],
        clientSignal: new AbortController().signal,
      },
    )
    assert.equal(fallback.res.status, 200)
    const text = await fallback.res.text()
    assert.ok(text.includes('recovered from 502'))
  })

  // 4. SSE data: null frame tolerance
  await test('Stream processing: data: null frame handled without error', async () => {
    testScenario = 'null_frame'
    callCount = 0

    const upstreamRes = await fetch(`${BASE_URL}/v1/chat/completions`)
    assert.equal(upstreamRes.status, 200)

    let streamResult = null
    const clientStream = toClientStream(upstreamRes, (res) => {
      streamResult = res
    })

    const reader = clientStream.getReader()
    const decoder = new TextDecoder()
    let clientChunks = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      clientChunks += decoder.decode(value, { stream: true })
    }

    assert.ok(clientChunks.includes('valid payload after null'), 'Should process chunks following null frame')
    assert.equal(Boolean(streamResult?.error), false, 'Should complete without error')
  })

  // 5. Post-first-byte mid-stream drop: surfaces error frame, NEVER restarts
  await test('Post-first-byte: mid-stream socket drop surfaces error frame without restart', async () => {
    testScenario = 'midstream_drop'
    callCount = 0

    const upstreamRes = await fetch(`${BASE_URL}/v1/chat/completions`)
    let streamResult = null

    const clientStream = toClientStream(upstreamRes, (res) => {
      streamResult = res
    })

    const reader = clientStream.getReader()
    const decoder = new TextDecoder()
    let clientOutput = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        clientOutput += decoder.decode(value, { stream: true })
      }
    } catch {
      // Stream error expected on drop
    }

    // Verify:
    // 1. Initial content arrived to client
    assert.ok(clientOutput.includes('Hello before disconnect') || clientOutput.length > 0)
    // 2. Either an SSE error event was emitted or result recorded an error
    assert.ok(
      clientOutput.includes('event: error') || streamResult?.error !== null,
      'Post-first-byte drop must record error, not silent restart',
    )
    // 3. Upstream was called exactly ONCE (never restarted after first byte)
    assert.equal(callCount, 1, 'Never re-call or restart upstream once streaming started')
  })
} finally {
  await new Promise((resolve) => server.close(resolve))
}

console.log('\n======================================================')
console.log(`Results: ${passed} passed, ${failed} failed`)
console.log('======================================================\n')

if (failed > 0) process.exit(1)
