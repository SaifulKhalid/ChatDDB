#!/usr/bin/env node

/**
 * Smoke test for first-byte delivery latency and text deduplication.
 *
 * Verifies that:
 * 1. For both wire formats (Responses API and Chat Completions), the first byte
 *    reaches the client within 300ms of the first upstream text frame.
 * 2. Text is never duplicated (output_text.done text is ignored).
 * 3. Captured fixtures from live providers pass with zero duplication and bounded peek.
 *
 * Reports before/after first_byte p50/p95 latency metrics.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'
import { peekToolCalls, toClientStream } from '../worker/sse.ts'
import { normalizeResponsesApiStream } from '../worker/routing.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const agentrouterFixture = readFileSync(resolve(__dirname, 'fixtures', 'agentrouter_text.sse'), 'utf-8')
const apinexFixture = readFileSync(resolve(__dirname, 'fixtures', 'apinex_text.sse'), 'utf-8')

let passed = 0
let failed = 0

function test(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

/** Helper to calculate percentiles */
function percentile(arr, p) {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]
}

/** Creates a timed delayed stream simulating upstream provider delays */
function createDelayedStream(frames, frameDelayMs = 15) {
  const encoder = new TextEncoder()
  let i = 0
  let firstFrameTime = null

  const stream = new ReadableStream({
    async pull(controller) {
      if (i >= frames.length) {
        controller.close()
        return
      }
      if (frameDelayMs > 0 && i > 0) {
        await new Promise((r) => setTimeout(r, frameDelayMs))
      }
      if (firstFrameTime === null && (frames[i].includes('content') || frames[i].includes('output_text.delta'))) {
        firstFrameTime = performance.now()
      }
      controller.enqueue(encoder.encode(frames[i++]))
    },
  })

  return {
    stream,
    getFirstFrameTime: () => firstFrameTime,
  }
}

/** Consumes client stream and records timing of first content byte */
async function consumeClientStream(readable) {
  const reader = readable.getReader()
  const decoder = new TextDecoder()
  let firstByteTime = null
  let firstContentTime = null
  let fullText = ''
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const now = performance.now()
    if (firstByteTime === null) firstByteTime = now

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const chunk = JSON.parse(payload)
        const content = chunk.choices?.[0]?.delta?.content
        if (typeof content === 'string' && content.length > 0) {
          if (firstContentTime === null) firstContentTime = now
          fullText += content
        }
      } catch {}
    }
  }

  return { firstByteTime, firstContentTime, fullText }
}

console.log('\n======================================================')
console.log('Smoke Test: First-Byte Latency & Deduplication')
console.log('======================================================\n')

// ---------------------------------------------------------------------------
// 1. Responses API Wire Format (AgentRouter)
// ---------------------------------------------------------------------------
console.log('1. Responses API wire format (AgentRouter):')
const responsesApiLatencies = []

for (let iter = 0; iter < 10; iter++) {
  const tokens = ['The', ' quick', ' brown', ' fox', ' jumps', ' over', ' the', ' lazy', ' dog.', ' A', ' fast', ' model', ' streams', ' smooth', ' tokens.']
  const frames = [
    'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
    'data: {"type":"response.output_item.added","item":{"type":"message","role":"assistant"}}\n\n',
    'data: {"type":"response.content_part.added","part":{"type":"text"}}\n\n',
    ...tokens.map((t) => `data: {"type":"response.output_text.delta","delta":"${t}"}\n\n`),
    // The bug trigger: output_text.done carries the complete combined text
    `data: {"type":"response.output_text.done","text":"${tokens.join('')}"}\n\n`,
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":15,"total_tokens":25}}}\n\n',
  ]

  const delayed = createDelayedStream(frames, 10)
  const normalizedStream = normalizeResponsesApiStream(delayed.stream)
  const peeked = await peekToolCalls(new Response(normalizedStream, { headers: { 'content-type': 'text/event-stream' } }))
  assert.strictEqual(peeked.kind, 'text')

  const clientStream = toClientStream(peeked.res)
  const { firstContentTime, fullText } = await consumeClientStream(clientStream)
  const upstreamFirst = delayed.getFirstFrameTime()

  assert(upstreamFirst !== null, 'Upstream first text frame must be recorded')
  assert(firstContentTime !== null, 'Client first content frame must be recorded')

  const latency = Math.round(firstContentTime - upstreamFirst)
  responsesApiLatencies.push(latency)

  if (iter === 0) {
    test(
      'first byte reaches client within 300ms of first upstream text frame',
      latency < 300,
      `took ${latency}ms`,
    )
    test(
      'assembled text matches expected without duplication',
      fullText === tokens.join(''),
      `got "${fullText.slice(0, 30)}..." (len: ${fullText.length})`,
    )
    const occurrences = (fullText.match(/The quick brown fox/g) || []).length
    test('no duplicate text emitted from output_text.done', occurrences === 1, `found ${occurrences} occurrences`)
  }
}

// ---------------------------------------------------------------------------
// 2. Chat Completions Wire Format (ApiNex)
// ---------------------------------------------------------------------------
console.log('\n2. Chat Completions wire format (ApiNex):')
const chatCompletionsLatencies = []

for (let iter = 0; iter < 10; iter++) {
  const tokens = ['Hello', ' world,', ' this', ' is', ' a', ' streaming', ' test', ' from', ' ApiNex', ' target.']
  const frames = [
    'data: {"id":"chatcmpl_1","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
    ...tokens.map((t) => `data: {"id":"chatcmpl_1","choices":[{"index":0,"delta":{"content":"${t}"},"finish_reason":null}]}\n\n`),
    'data: {"id":"chatcmpl_1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]

  const delayed = createDelayedStream(frames, 10)
  const peeked = await peekToolCalls(new Response(delayed.stream, { headers: { 'content-type': 'text/event-stream' } }))
  assert.strictEqual(peeked.kind, 'text')

  const clientStream = toClientStream(peeked.res)
  const { firstContentTime, fullText } = await consumeClientStream(clientStream)
  const upstreamFirst = delayed.getFirstFrameTime()

  assert(upstreamFirst !== null, 'Upstream first text frame must be recorded')
  assert(firstContentTime !== null, 'Client first content frame must be recorded')

  const latency = Math.round(firstContentTime - upstreamFirst)
  chatCompletionsLatencies.push(latency)

  if (iter === 0) {
    test(
      'first byte reaches client within 300ms of first upstream text frame',
      latency < 300,
      `took ${latency}ms`,
    )
    test(
      'assembled text matches expected without duplication',
      fullText === tokens.join(''),
      `got "${fullText.slice(0, 30)}..."`,
    )
  }
}

// ---------------------------------------------------------------------------
// 3. Captured Live Fixtures
// ---------------------------------------------------------------------------
console.log('\n3. Real Captured Fixtures verification:')
{
  // AgentRouter fixture
  const arBody = new Response(agentrouterFixture, { headers: { 'content-type': 'text/event-stream' } }).body
  const normalized = normalizeResponsesApiStream(arBody)
  const peeked = await peekToolCalls(new Response(normalized, { headers: { 'content-type': 'text/event-stream' } }))
  const clientStream = toClientStream(peeked.res)
  const { fullText } = await consumeClientStream(clientStream)

  const count = (fullText.match(/1\. \*\*WeekendForge\*\*/g) || []).length
  test('AgentRouter fixture: "1. **WeekendForge**" appears exactly once (no trailing duplicate)', count === 1, `count: ${count}`)
  test('AgentRouter fixture: text is non-empty and well-formed', fullText.length > 200, `length: ${fullText.length}`)
}

{
  // ApiNex fixture
  const anBody = new Response(apinexFixture, { headers: { 'content-type': 'text/event-stream' } }).body
  const peeked = await peekToolCalls(new Response(anBody, { headers: { 'content-type': 'text/event-stream' } }))
  const clientStream = toClientStream(peeked.res)
  const { fullText } = await consumeClientStream(clientStream)

  const count = (fullText.match(/1\. Weekend Compiler/g) || []).length
  test('ApiNex fixture: "1. Weekend Compiler" appears exactly once', count === 1, `count: ${count}`)
  test('ApiNex fixture: stream completes cleanly with all 5 items', fullText.includes('5. Sunday Deploy'), `got text: ${fullText}`)
}

// ---------------------------------------------------------------------------
// Metrics Summary
// ---------------------------------------------------------------------------
console.log('\n======================================================')
console.log('First-Byte Latency Metrics (relative to upstream TTFB):')
console.log('======================================================')
const allLatencies = [...responsesApiLatencies, ...chatCompletionsLatencies]
const p50 = percentile(allLatencies, 50)
const p95 = percentile(allLatencies, 95)

console.log(`  AgentRouter  (Responses API):   p50 = ${percentile(responsesApiLatencies, 50)}ms, p95 = ${percentile(responsesApiLatencies, 95)}ms`)
console.log(`  ApiNex       (Chat Completions): p50 = ${percentile(chatCompletionsLatencies, 50)}ms, p95 = ${percentile(chatCompletionsLatencies, 95)}ms`)
console.log(`  Combined                        p50 = ${p50}ms, p95 = ${p95}ms`)
console.log(`\nBefore (production stall): p50 = ~21,000ms, p95 = ~36,000ms (buffered until EOF)`)
console.log(`After (bounded peek):      p50 = ${p50}ms, p95 = ${p95}ms (released immediately)`)
console.log('======================================================\n')

if (failed > 0) {
  console.error(`Failed ${failed} tests.`)
  process.exit(1)
} else {
  console.log(`All ${passed} tests passed successfully!`)
}
