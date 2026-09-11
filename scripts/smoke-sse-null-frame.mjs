#!/usr/bin/env node

/**
 * Pins the `data: null` frame — the bug that broke every `claude-opus-5` turn.
 *
 * ## What happened
 *
 * AgentRouter reaches Anthropic natively and re-serialises the reply into an
 * OpenAI-compatible stream. One of Anthropic's native events has no OpenAI
 * equivalent, and instead of dropping it the gateway writes the JSON for
 * "nothing":
 *
 *   data: null
 *
 * Measured on the live gateway, frame 5 of 8, mid-stream. `gpt-5.6-sol` never
 * sends one, which is why this survived until Claude was offered in the picker.
 *
 * Every reader guarded its parse with `try { JSON.parse(payload) } catch`, which
 * looks like a guard and is not: `JSON.parse('null')` *succeeds* and returns
 * `null`. The catch only ever fired on malformed JSON. So `extractError(null)`
 * read `.error` off null, threw a `TypeError`, and the user watched their answer
 * stop mid-sentence and turn into:
 *
 *   Stream interrupted: Cannot read properties of null (reading 'error')
 *
 * Both readers are covered here because both meet the frame, in order:
 * `peekToolCalls` scans first and used to die on `null.choices` — it caught that
 * and replayed, which is why the message named `error` and not `choices` — then
 * `toClientStream` died for real on `null.error`.
 *
 * Usage:
 *   npm run smoke:sse-null
 *
 * Runs in plain Node with type stripping — no server, no credentials, no spend.
 */

import { peekToolCalls, toClientStream } from '../worker/sse.ts'

let passed = 0
let failed = 0

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`
const content = (text) => frame({ choices: [{ delta: { content: text } }] })
const finish = (reason) => frame({ choices: [{ delta: {}, finish_reason: reason }] })
const DONE = 'data: [DONE]\n\n'

/** The frame itself, exactly as AgentRouter puts it on the wire. */
const NULL_FRAME = 'data: null\n\n'

function sseResponse(frames) {
  const encoder = new TextEncoder()
  let i = 0
  const body = new ReadableStream({
    pull(controller) {
      if (i >= frames.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(frames[i++]))
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

/** Drains a client stream to text, with the tap's verdict alongside it. */
async function drain(res) {
  let result = null
  const stream = toClientStream(res, (r) => {
    result = r
  })
  const text = await new Response(stream).text()
  return { text, result }
}

/** The prose a client would actually render, pulled back out of the frames. */
function rendered(text) {
  let out = ''
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload)
      const delta = parsed?.choices?.[0]?.delta?.content
      if (typeof delta === 'string') out += delta
    } catch {
      /* not a content frame */
    }
  }
  return out
}

console.log('\nworker/sse.ts — a null frame mid-stream (the claude-opus-5 bug)\n')

// ---------------------------------------------------------------------------
console.log('  1. the exact production stream survives it')
// ---------------------------------------------------------------------------
{
  // The measured shape: content, the null frame, then the rest of the answer.
  const res = sseResponse([
    content('The Routh array’s first column '),
    NULL_FRAME,
    content('decides stability.'),
    finish('stop'),
    DONE,
  ])
  const { text, result } = await drain(res)

  check('no TypeError reached the client', !text.includes('Cannot read properties'), text.slice(0, 120))
  check('the stream was not reported as interrupted', !text.includes('Stream interrupted'))
  check('the tap recorded no error', result?.error === null, String(result?.error))
  check('finish_reason survived the null frame', result?.finishReason === 'stop', result?.finishReason)
  check(
    'both halves of the answer arrived',
    rendered(text) === 'The Routh array’s first column decides stability.',
    rendered(text),
  )
  check('the stream still terminated', text.includes('data: [DONE]'))
}

// ---------------------------------------------------------------------------
console.log('\n  2. a null frame before any content is not an empty completion')
// ---------------------------------------------------------------------------
{
  // Ordering matters: were the frame miscounted as content, an genuinely empty
  // reply would stop being reported as one.
  const res = sseResponse([NULL_FRAME, content('ok'), finish('stop'), DONE])
  const { text, result } = await drain(res)
  check('the content still arrived', rendered(text) === 'ok', rendered(text))
  check('no error recorded', result?.error === null, String(result?.error))
}

// ---------------------------------------------------------------------------
console.log('\n  3. a stream of nothing but null frames is still empty')
// ---------------------------------------------------------------------------
{
  // The guard skips the frame; it must not make it count as content, or a reply
  // that never said anything would be logged as a success.
  const res = sseResponse([NULL_FRAME, NULL_FRAME, DONE])
  const { text, result } = await drain(res)
  check('reported as an empty response', /empty/i.test(String(result?.error)), String(result?.error))
  check('the client was told', text.includes('empty_completion'))
}

// ---------------------------------------------------------------------------
console.log('\n  4. a real error frame is still an error')
// ---------------------------------------------------------------------------
{
  // The guard skips frames carrying nothing — it must not skip frames carrying
  // a failure, which is the one thing that reads the same field.
  const res = sseResponse([
    content('starting'),
    NULL_FRAME,
    frame({ error: { message: 'upstream exploded', type: 'server_error' } }),
    DONE,
  ])
  const { text, result } = await drain(res)
  check('the error survived', result?.error === 'upstream exploded', String(result?.error))
  check('and reached the client', text.includes('upstream exploded'))
}

// ---------------------------------------------------------------------------
console.log('\n  5. peekToolCalls does not choke on it either')
// ---------------------------------------------------------------------------
{
  // It meets the frame first. It used to die on `null.choices`, catch its own
  // TypeError, and replay — which is why the crash the user saw named `error`.
  const raw = [content('Here is the diagram.'), NULL_FRAME, finish('stop'), DONE]
  const peek = await peekToolCalls(sseResponse(raw))
  check('verdict is text', peek.kind === 'text', peek.kind)
  if (peek.kind === 'text') {
    const replayed = await peek.res.text()
    check('the replay is byte-identical, null frame and all', replayed === raw.join(''), `${replayed.length} chars`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n  6. a tool call behind a null frame is still found')
// ---------------------------------------------------------------------------
{
  // The frame lands between the preamble and the call in the shape that matters:
  // skipping it must not end the lookahead early.
  const args = JSON.stringify({ prompt: 'a signal flow graph' })
  const res = sseResponse([
    content('Let me draw that.'),
    NULL_FRAME,
    frame({
      choices: [
        { delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'generate_image', arguments: args } }] } },
      ],
    }),
    finish('tool_calls'),
    DONE,
  ])
  const peek = await peekToolCalls(res)
  check('the call was still found', peek.kind === 'tool', peek.kind)
  if (peek.kind === 'tool') {
    check('name intact', peek.calls[0]?.function.name === 'generate_image', peek.calls[0]?.function.name)
    check('arguments intact', peek.calls[0]?.function.arguments === args, peek.calls[0]?.function.arguments)
  }
}

// ---------------------------------------------------------------------------
console.log('\n  7. a non-streamed body of bare null')
// ---------------------------------------------------------------------------
{
  // The same footgun one layer over: `res.json()` on a body of `null` yields
  // null, and the old code read `.error` straight off it.
  const res = new Response('null', { headers: { 'content-type': 'application/json' } })
  const { text, result } = await drain(res)
  check('no TypeError', !text.includes('Cannot read properties'), text.slice(0, 120))
  check('reported as an empty response', /empty/i.test(String(result?.error)), String(result?.error))
}

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? '  all green' : `  ${failed} failed`} — ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
