#!/usr/bin/env node

/**
 * Tests `peekToolCalls` in `worker/sse.ts` — the decision that says whether a
 * turn is prose or a tool call.
 *
 * ## Why this file exists
 *
 * It shipped with a rule called "first signal wins": whichever arrived first,
 * content or a call, decided the turn. That rule lost 29% of image-intent turns
 * in production. The model wrote its introducing sentence, the peeker saw
 * content, and the `generate_image` call behind it was discarded — generated,
 * billed, and dropped, with `finish_reason='tool_calls'` and no attachment as
 * the only trace. Case 2 below is that exact stream.
 *
 * The fix reads a bounded distance past the first content frame. Bounded is the
 * load-bearing word: nothing may reach the client until the verdict is in, so
 * every frame read here is a frame the user waits for. Cases 4 and 5 are the
 * latency guard, and they assert on frames actually pulled from the source
 * rather than on wall-clock, which would be flaky.
 *
 * Usage:
 *   npm run smoke:tool-peek
 *
 * Runs in plain Node with type stripping — no server, no credentials, no spend.
 */

import { peekToolCalls } from '../worker/sse.ts'

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

const toolStart = (name = 'generate_image', id = 'call_1') =>
  frame({
    choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] } }],
  })

/** `function.arguments` split one token per frame, the way AgentRouter sends it. */
function toolArgs(args) {
  const pieces = args.match(/.{1,6}/g) ?? []
  return pieces.map((p) => frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: p } }] } }] }))
}

/**
 * An SSE `Response` over `frames`, counting how many are actually pulled.
 *
 * The counter is the latency assertion: a peek that buffers a whole reply before
 * deciding would pull every frame, and that is precisely the regression the
 * bound exists to prevent.
 */
function sseResponse(frames) {
  const state = { pulled: 0 }
  const encoder = new TextEncoder()
  let i = 0
  const body = new ReadableStream({
    pull(controller) {
      if (i >= frames.length) {
        controller.close()
        return
      }
      state.pulled++
      controller.enqueue(encoder.encode(frames[i++]))
    },
  })
  const res = new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  return { res, state, raw: frames.join('') }
}

console.log('\nworker/sse.ts — peekToolCalls\n')

// ---------------------------------------------------------------------------
console.log('  1. ordinary prose is still prose')
// ---------------------------------------------------------------------------
{
  const { res, raw } = sseResponse([content('Routh–Hurwitz needs the first column.'), finish('stop'), DONE])
  const peek = await peekToolCalls(res)
  check('verdict is text', peek.kind === 'text', peek.kind)
  if (peek.kind === 'text') {
    const replayed = await peek.res.text()
    check('the replay is byte-identical', replayed === raw, `${replayed.length} vs ${raw.length} chars`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n  2. prose BEFORE a tool call — the production bug')
// ---------------------------------------------------------------------------
{
  const args = JSON.stringify({ prompt: 'a fluffy orange cat asleep on a windowsill' })
  const { res } = sseResponse([
    content('Here is a beautiful cat portrait.'),
    toolStart(),
    ...toolArgs(args),
    finish('tool_calls'),
    DONE,
  ])
  const peek = await peekToolCalls(res)
  check('the tool call wins despite the preamble', peek.kind === 'tool', peek.kind)
  if (peek.kind === 'tool') {
    check('exactly one call', peek.calls.length === 1, String(peek.calls.length))
    check('the name survived', peek.calls[0]?.function.name === 'generate_image', peek.calls[0]?.function.name)
    check(
      'the arguments reassembled across frames',
      peek.calls[0]?.function.arguments === args,
      peek.calls[0]?.function.arguments,
    )
  }
}

// ---------------------------------------------------------------------------
console.log('\n  3. a tool call with no preamble still works')
// ---------------------------------------------------------------------------
{
  const args = JSON.stringify({ prompt: 'a signal flow graph' })
  const { res } = sseResponse([toolStart(), ...toolArgs(args), finish('tool_calls'), DONE])
  const peek = await peekToolCalls(res)
  check('verdict is tool', peek.kind === 'tool', peek.kind)
  if (peek.kind === 'tool') check('arguments intact', peek.calls[0]?.function.arguments === args)
}

// ---------------------------------------------------------------------------
console.log('\n  4. a terminal frame ends the lookahead immediately')
// ---------------------------------------------------------------------------
{
  // AgentRouter's shape: prose as one blob, then finish_reason. The scan must
  // stop there rather than spending its whole budget on a finished stream.
  const tail = Array.from({ length: 40 }, (_, i) => content(` ignored-${i}`))
  const { res, state } = sseResponse([content('A single blob of prose.'), finish('stop'), DONE, ...tail])
  const peek = await peekToolCalls(res)
  check('verdict is text', peek.kind === 'text', peek.kind)
  check('stopped reading at the terminal frame', state.pulled <= 3, `pulled ${state.pulled} frames`)
}

// ---------------------------------------------------------------------------
console.log('\n  5. token-by-token prose is not buffered to the end')
// ---------------------------------------------------------------------------
{
  // A gateway that really streams. Without a bound, the peek would swallow the
  // entire reply before the client saw a byte.
  const many = Array.from({ length: 400 }, (_, i) => content(`word${i} `))
  const { res, state } = sseResponse([...many, finish('stop'), DONE])
  const peek = await peekToolCalls(res)
  check('verdict is text', peek.kind === 'text', peek.kind)
  check('bailed out well before the end', state.pulled <= 20, `pulled ${state.pulled} of 402 frames`)
  if (peek.kind === 'text') {
    const replayed = await peek.res.text()
    check('the replay still contains the whole reply', replayed.includes('word399'), `${replayed.length} chars`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n  6. a call further out than the bound is honestly missed')
// ---------------------------------------------------------------------------
{
  // Documents the trade rather than pretending it does not exist: past the
  // budget the turn is prose, and the client gets the text it already produced.
  const long = Array.from({ length: 60 }, (_, i) => content(`filler${i} `))
  const { res } = sseResponse([...long, toolStart(), ...toolArgs('{"prompt":"late"}'), finish('tool_calls'), DONE])
  const peek = await peekToolCalls(res)
  check('falls back to text past the bound', peek.kind === 'text', peek.kind)
}

// ---------------------------------------------------------------------------
console.log('\n  7. a mangled call falls back to replaying the stream')
// ---------------------------------------------------------------------------
{
  // No `function.name` anywhere: `assembleToolCalls` drops it, and the pump gets
  // the original bytes rather than an empty turn.
  const { res, raw } = sseResponse([
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"prompt":"x"}' } }] } }] }),
    finish('tool_calls'),
    DONE,
  ])
  const peek = await peekToolCalls(res)
  check('verdict is text', peek.kind === 'text', peek.kind)
  if (peek.kind === 'text') {
    const replayed = await peek.res.text()
    check('nothing was lost in the fallback', replayed === raw, `${replayed.length} vs ${raw.length}`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n  8. a non-streamed JSON body with prose and a call')
// ---------------------------------------------------------------------------
{
  // A relay that ignored `stream: true`. This path always read the whole body,
  // so it never had the bug — asserted so it stays that way.
  const body = JSON.stringify({
    choices: [
      {
        message: {
          content: 'Here is the diagram.',
          tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'generate_image', arguments: '{"prompt":"y"}' } }],
        },
      },
    ],
  })
  const res = new Response(body, { headers: { 'content-type': 'application/json' } })
  const peek = await peekToolCalls(res)
  check('verdict is tool', peek.kind === 'tool', peek.kind)
  if (peek.kind === 'tool') check('name intact', peek.calls[0]?.function.name === 'generate_image')
}

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? '  all green' : `  ${failed} failed`} — ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
