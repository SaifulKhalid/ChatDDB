#!/usr/bin/env node

/**
 * Probes whether AgentRouter forwards OpenAI-style tool calling to the model.
 *
 * This is the check that has to pass before `generate_image` is wired into
 * `worker/routes/chat.ts`. AgentRouter is a relay, and a relay can do three
 * different things with a `tools` field: honour it, reject the request, or drop
 * it on the floor and answer as if it were never sent. The third is the
 * dangerous one — it looks like a working deployment right up until a user asks
 * for a diagram and gets a paragraph describing one.
 *
 * ## Why it runs the same prompt several times
 *
 * A model deciding to call a tool is a *sampling* outcome, not a capability
 * flag. One successful `tool_calls` response proves the plumbing exists; it does
 * not prove the feature is reliable. So each prompt runs `RUNS` times and the
 * report is a hit rate, not a yes/no. Anything short of a clean sweep on
 * prompts this explicit means the model is unreliable at deciding, which is a
 * different problem from the gateway not supporting the field.
 *
 * ## What each phase establishes
 *
 *   1. trigger    an explicit "draw me X" produces `tool_calls`, not prose
 *   2. restraint  an ordinary question does *not* produce `tool_calls`
 *   3. roundtrip  a `role: 'tool'` result is accepted and yields final text
 *   4. refusal    a tool result saying "unavailable" yields a plain explanation
 *   5. streaming  `tools` + `stream: true` still produces a usable `tool_calls`
 *
 * Phase 3 is the one Task 2 actually depends on: the Worker executes the tool
 * server-side and has to hand the result back for the model's closing sentence.
 * A gateway that returns `tool_calls` but rejects the follow-up message is no
 * more usable than one that never supported tools.
 *
 * ## Why phase 5 exists, and what it decided
 *
 * Phases 1-4 all ask with `stream: false`, which is *not* how `worker/chat.ts`
 * talks to a gateway — `createChatCompletion` sends `stream: true` and hands the
 * body to `sse.ts`. Proving tool calling works non-streamed proves nothing about
 * the request the Worker actually makes, so phase 5 asks the same question over
 * SSE and reports the frame shape.
 *
 * This is a design input, not a pass/fail: a gateway that will not stream
 * `tool_calls` is still usable, it just forces the tool-decision leg to be
 * non-streamed. It does not gate the verdict for that reason.
 *
 * ## The tool-result wording is load-bearing, and this probe found out the hard way
 *
 * An earlier version sent `{status: 'ok', note: 'Image generated and attached to
 * your reply.'}` and the model answered with **nothing at all** — HTTP 200,
 * `finish_reason: 'stop'`, four output tokens, empty `content`. Told the image
 * was already attached, it concluded there was nothing left to say, and the user
 * would have got a bare image with no sentence around it. Told instead to
 * introduce it, the same model answers every time.
 *
 * A bare `{status: 'ok'}` has the opposite failure: the model helpfully writes
 * `![Three-Tier Web Architecture](attachment://generated_image.png)`, a Markdown
 * link to a file that does not exist, which renders as a broken image next to
 * the real one.
 *
 * So the strings below are not illustrative — they are the shipped wording, and
 * phases 3 and 4 assert both properties (non-empty text, no Markdown image
 * link). Change `worker/routes/chat.ts` and you have to re-run this.
 *
 * Usage:
 *   npm run probe:tools
 *   RUNS=8 node scripts/probe-tool-calling.mjs
 *
 * Reads AGENTROUTER_API_KEY and related vars from environment / .dev.vars.
 * Exits non-zero unless every phase passes on every run.
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .dev.vars if present
const devVars = resolve(__dirname, '..', '.dev.vars')
if (existsSync(devVars)) {
  const text = readFileSync(devVars, 'utf-8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim()
      const val = trimmed.slice(eq + 1).trim()
      if (!process.env[key]) process.env[key] = val
    }
  }
}

const API_KEY = process.env.AGENTROUTER_API_KEY
if (!API_KEY) {
  console.error('error: AGENTROUTER_API_KEY is not set')
  process.exit(1)
}

const BASE_URL = process.env.AGENTROUTER_BASE_URL ?? 'https://agentrouter.org/v1'
const MODEL = process.env.AGENTROUTER_MODEL ?? 'gpt-5.6-sol'
const USER_AGENT = process.env.AGENTROUTER_USER_AGENT ?? 'claude-cli/2.1.158 (external, sdk-cli)'
/** Runs per prompt. Five is the floor the feature was signed off against. */
const RUNS = Number.parseInt(process.env.RUNS ?? '5', 10)

/**
 * The schema exactly as `worker/routes/chat.ts` sends it.
 *
 * Kept literal here rather than imported: the probe's job is to prove that
 * *this shape* survives the gateway, and importing it from the Worker would
 * make the probe pass by construction if someone later reshaped the schema.
 */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description:
        'Generate an image and attach it to your reply. Call this only when the user is ' +
        'asking to see, visualise, or be shown something — never to decorate an answer.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'A complete, self-contained description of the image to generate, in English. ' +
              'Compose it from the conversation; the image model sees nothing but this string.',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
  },
]

/** Generous: a reasoning model spends this budget on thinking first. */
const MAX_TOKENS = 2000

async function post(messages, extra = {}) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // AgentRouter's edge whitelists clients; see worker/agentrouter.ts.
      'User-Agent': USER_AGENT,
      'X-App': 'cli',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_completion_tokens: MAX_TOKENS,
      stream: false,
      ...extra,
    }),
  })

  const text = await res.text()
  if (!res.ok) {
    // A 400 naming `tools` or `tool_choice` is the gateway saying it will not
    // carry the field at all — a different failure from a model that ignored it.
    const lower = text.toLowerCase()
    const refused = res.status === 400 && (lower.includes('tool') || lower.includes('function'))
    return { ok: false, refused, detail: `HTTP ${res.status} — ${text.slice(0, 300)}` }
  }
  try {
    return { ok: true, body: JSON.parse(text) }
  } catch {
    return { ok: false, refused: false, detail: `unparseable body — ${text.slice(0, 200)}` }
  }
}

function firstMessage(body) {
  return body?.choices?.[0]?.message ?? {}
}

function toolCallsOf(message) {
  return Array.isArray(message?.tool_calls) ? message.tool_calls : []
}

/** Content can arrive as a string or as OpenAI's part array. */
function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text) : '')).join('')
  }
  return ''
}

/**
 * The tool-use clause, verbatim from `TOOL_USE_CLAUSE` in
 * `worker/routes/chat.ts`, appended to a stand-in base prompt exactly as
 * `buildUpstreamMessages` appends it to whichever base prompt resolves.
 */
const TOOL_USE_CLAUSE = [
  'You can attach one generated image to a reply by calling the `generate_image` tool.',
  'Call it only when the user asks to see, visualise, draw, or be shown something —',
  'never to illustrate an answer nobody asked to see.',
  'Compose the `prompt` argument yourself from the conversation: the image model reads that',
  'string and nothing else, so it must stand alone.',
  'At most one image per reply — every call spends a small budget shared by all users.',
  'The image is attached to your reply automatically: introduce it in one short sentence,',
  'and never write a Markdown image link for it.',
].join(' ')

const SYSTEM = {
  role: 'system',
  content: `You are ChatDDB, a helpful, knowledgeable AI assistant.\n\n${TOOL_USE_CLAUSE}`,
}

/** `TOOL_RESULT_OK` in `worker/routes/chat.ts`. */
const TOOL_RESULT_OK = JSON.stringify({
  status: 'ok',
  instruction:
    'The image has been generated and attached to your reply. Introduce it in one short ' +
    'sentence. Do not write a Markdown image link — the attachment renders on its own.',
})

/** `toolResultUnavailable()` in `worker/routes/chat.ts`, with the rate-limit reason. */
const TOOL_RESULT_UNAVAILABLE = JSON.stringify({
  status: 'unavailable',
  reason: "You have reached today's limit of 5 generated images. It resets at midnight UTC.",
  instruction:
    'No image was generated and nothing is attached. Tell the user plainly that you could ' +
    'not make the image and why. Do not retry the tool.',
})

/** Prompts that should leave a model no room to decide otherwise. */
const TRIGGER_CASES = [
  {
    name: 'draw a diagram (explicit)',
    messages: [SYSTEM, { role: 'user', content: 'Draw me a diagram of a three-tier web architecture.' }],
  },
  {
    // The Task 2 use case: the request never names the subject, so a usable
    // tool call also proves the model composed the prompt from context.
    name: 'implicit follow-up ("show me that")',
    messages: [
      SYSTEM,
      { role: 'user', content: 'Explain in two sentences how a lighthouse works.' },
      {
        role: 'assistant',
        content:
          'A lighthouse houses a bright lamp at the top of a tall tower, positioned so it is ' +
          'visible far out to sea. A rotating lens focuses that light into a beam, and the ' +
          'timing of its flashes identifies which lighthouse a sailor is looking at.',
      },
      { role: 'user', content: 'Can you show me a picture of that?' },
    ],
  },
]

/** The control: no image intent at all, so a tool call here is a false positive. */
const RESTRAINT_CASE = {
  name: 'ordinary question (must NOT fire)',
  messages: [SYSTEM, { role: 'user', content: 'In one sentence, what is a B-tree?' }],
}

async function probeTrigger(testCase) {
  const outcomes = []
  for (let run = 1; run <= RUNS; run++) {
    const result = await post(testCase.messages, { tools: TOOLS, tool_choice: 'auto' })
    if (!result.ok) {
      console.log(`  run ${run}/${RUNS}  ERROR  ${result.refused ? '(field refused) ' : ''}${result.detail}`)
      outcomes.push({ hit: false, fatal: true, refused: result.refused })
      continue
    }
    const message = firstMessage(result.body)
    const calls = toolCallsOf(message)
    const call = calls.find((c) => c?.function?.name === 'generate_image')
    if (!call) {
      console.log(`  run ${run}/${RUNS}  MISS   answered with text: "${textOf(message).slice(0, 90).replace(/\n/g, ' ')}"`)
      outcomes.push({ hit: false })
      continue
    }
    // A tool call with an unparseable or empty `prompt` is a miss too: the
    // Worker would have nothing to generate from.
    let prompt = ''
    try {
      prompt = JSON.parse(call.function.arguments ?? '{}').prompt ?? ''
    } catch {
      /* left empty, reported below */
    }
    if (!prompt.trim()) {
      console.log(`  run ${run}/${RUNS}  MISS   tool_calls present but no usable prompt: ${call.function.arguments}`)
      outcomes.push({ hit: false })
      continue
    }
    console.log(`  run ${run}/${RUNS}  HIT    prompt="${prompt.slice(0, 90).replace(/\n/g, ' ')}"`)
    outcomes.push({ hit: true, call, prompt })
  }
  return outcomes
}

async function probeRestraint() {
  const outcomes = []
  for (let run = 1; run <= RUNS; run++) {
    const result = await post(RESTRAINT_CASE.messages, { tools: TOOLS, tool_choice: 'auto' })
    if (!result.ok) {
      console.log(`  run ${run}/${RUNS}  ERROR  ${result.detail}`)
      outcomes.push({ quiet: false, fatal: true })
      continue
    }
    const message = firstMessage(result.body)
    const fired = toolCallsOf(message).length > 0
    console.log(
      `  run ${run}/${RUNS}  ${fired ? 'FIRED ' : 'QUIET '} "${textOf(message).slice(0, 80).replace(/\n/g, ' ')}"`,
    )
    outcomes.push({ quiet: !fired })
  }
  return outcomes
}

/** A Markdown image link the model invented for a file that does not exist. */
const INVENTED_IMAGE_LINK = /!\[[^\]]*\]\([^)]*\)/

/**
 * Feeds a tool result back and asks for the closing sentence.
 *
 * The assistant turn carrying `tool_calls` has to be echoed back verbatim
 * before the `role: 'tool'` message, exactly as the Worker will do it — a
 * gateway that accepts the first request but not this one cannot serve Task 2.
 *
 * `tools` is deliberately *not* resent on this leg, matching the Worker: the
 * model has had its turn with the tool, and re-offering it invites a second
 * call the loop would then have to spend a round rejecting.
 */
async function probeRoundtrip(messages, call, toolResult, expect) {
  const outcomes = []
  for (let run = 1; run <= RUNS; run++) {
    const result = await post([
      ...messages,
      { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, content: toolResult },
    ])
    if (!result.ok) {
      console.log(`  run ${run}/${RUNS}  ERROR  ${result.detail}`)
      outcomes.push(false)
      continue
    }
    const text = textOf(firstMessage(result.body)).trim()
    if (!text) {
      // The failure the old wording produced: accepted, billed, and silent.
      console.log(`  run ${run}/${RUNS}  FAIL   accepted the tool result but returned no text`)
      outcomes.push(false)
      continue
    }
    if (INVENTED_IMAGE_LINK.test(text)) {
      console.log(`  run ${run}/${RUNS}  FAIL   invented a Markdown image link: "${text.slice(0, 100)}"`)
      outcomes.push(false)
      continue
    }
    if (expect && !expect.test(text)) {
      console.log(`  run ${run}/${RUNS}  FAIL   text does not explain the failure: "${text.slice(0, 100)}"`)
      outcomes.push(false)
      continue
    }
    console.log(`  run ${run}/${RUNS}  PASS   "${text.slice(0, 100).replace(/\n/g, ' ')}"`)
    outcomes.push(true)
  }
  return outcomes
}

/**
 * Asks with `stream: true` and reports how — or whether — `tool_calls` arrive.
 *
 * Three things the Worker's design depends on, and none of them are knowable
 * from the non-streamed phases:
 *
 *   - do `tool_calls` survive the streaming path at all, or does the gateway
 *     answer with prose (or an error) once `stream: true` is set?
 *   - do they arrive as `delta.tool_calls` (OpenAI's fragmented form, assembled
 *     by `index`) or as a whole `message.tool_calls` on one frame?
 *   - are `function.arguments` split across frames, which is the case that
 *     forces the consumer to concatenate before parsing?
 *
 * Reports the raw first tool-bearing frame, because "it worked" is not an
 * answer anyone can write a parser against.
 */
async function probeStreaming(testCase) {
  const outcomes = []
  for (let run = 1; run <= RUNS; run++) {
    let res
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'User-Agent': USER_AGENT,
          'X-App': 'cli',
        },
        body: JSON.stringify({
          model: MODEL,
          messages: testCase.messages,
          max_completion_tokens: MAX_TOKENS,
          stream: true,
          stream_options: { include_usage: true },
          tools: TOOLS,
          tool_choice: 'auto',
        }),
      })
    } catch (err) {
      console.log(`  run ${run}/${RUNS}  ERROR  ${err.message}`)
      outcomes.push({ ok: false })
      continue
    }

    if (!res.ok) {
      const body = await res.text()
      console.log(`  run ${run}/${RUNS}  ERROR  HTTP ${res.status} — ${body.slice(0, 200)}`)
      outcomes.push({ ok: false })
      continue
    }

    const contentType = res.headers.get('content-type') ?? ''
    const raw = await res.text()

    // Collect every `data:` payload, exactly as `sse.ts` splits them.
    const payloads = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload && payload !== '[DONE]') payloads.push(payload)
    }

    let frames = 0
    let deltaForm = false
    let messageForm = false
    let argFragments = 0
    let name = ''
    let args = ''
    let text = ''
    let firstToolFrame = null

    for (const payload of payloads) {
      let chunk
      try {
        chunk = JSON.parse(payload)
      } catch {
        continue
      }
      const choice = chunk?.choices?.[0]
      if (!choice) continue

      const deltaCalls = choice.delta?.tool_calls
      const messageCalls = choice.message?.tool_calls
      const calls = Array.isArray(deltaCalls) ? deltaCalls : Array.isArray(messageCalls) ? messageCalls : null
      if (calls) {
        if (!firstToolFrame) firstToolFrame = payload
        if (Array.isArray(deltaCalls)) deltaForm = true
        if (Array.isArray(messageCalls)) messageForm = true
        frames++
        for (const call of calls) {
          if (call?.function?.name) name = call.function.name
          const fragment = call?.function?.arguments
          if (typeof fragment === 'string' && fragment.length > 0) {
            args += fragment
            argFragments++
          }
        }
      }

      const content = choice.delta?.content ?? choice.message?.content
      if (typeof content === 'string') text += content
    }

    if (frames === 0) {
      console.log(
        `  run ${run}/${RUNS}  MISS   no tool_calls over SSE (content-type ${contentType || '-'}, ` +
          `${payloads.length} frames); text: "${text.slice(0, 70).replace(/\n/g, ' ')}"`,
      )
      outcomes.push({ ok: false })
      continue
    }

    let prompt = ''
    try {
      prompt = JSON.parse(args || '{}').prompt ?? ''
    } catch {
      /* reported below */
    }

    const form = deltaForm && messageForm ? 'delta+message' : deltaForm ? 'delta' : 'message'
    console.log(
      `  run ${run}/${RUNS}  ${prompt.trim() ? 'HIT   ' : 'MISS  '} form=${form} frames=${frames} ` +
        `argFragments=${argFragments} name=${name || '-'} prompt="${prompt.slice(0, 50).replace(/\n/g, ' ')}"`,
    )
    if (run === 1) console.log(`         first tool frame: ${firstToolFrame.slice(0, 300)}`)
    outcomes.push({ ok: Boolean(prompt.trim()), form, frames, argFragments })
  }
  return outcomes
}

async function main() {
  console.log(`probing ${BASE_URL} with model ${MODEL}, ${RUNS} runs per case\n`)

  let hits = 0
  let attempts = 0
  let refusedField = false
  let sampleCall = null
  let sampleMessages = null

  for (const testCase of TRIGGER_CASES) {
    console.log(`phase 1 — ${testCase.name}`)
    const outcomes = await probeTrigger(testCase)
    attempts += outcomes.length
    hits += outcomes.filter((o) => o.hit).length
    if (outcomes.some((o) => o.refused)) refusedField = true
    const first = outcomes.find((o) => o.hit)
    if (first && !sampleCall) {
      sampleCall = first.call
      sampleMessages = testCase.messages
    }
    console.log(`  → ${outcomes.filter((o) => o.hit).length}/${outcomes.length} hit\n`)
  }

  if (refusedField) {
    console.log('tools: no — AgentRouter refused the `tools` field outright.')
    process.exit(1)
  }

  console.log(`phase 2 — ${RESTRAINT_CASE.name}`)
  const restraint = await probeRestraint()
  const quiet = restraint.filter((o) => o.quiet).length
  console.log(`  → ${quiet}/${restraint.length} stayed quiet\n`)

  console.log('phase 3 — tool result round trip (success)')
  let ok = []
  let refused = []
  if (sampleCall) {
    ok = await probeRoundtrip(sampleMessages, sampleCall, TOOL_RESULT_OK, null)
    console.log(`  → ${ok.filter(Boolean).length}/${ok.length} answered\n`)

    console.log('phase 4 — tool result round trip (generation unavailable)')
    // The model must say so in words. A silent turn here is the exact failure
    // Task 2 calls out: no image, no explanation, nothing the user can act on.
    refused = await probeRoundtrip(
      sampleMessages,
      sampleCall,
      TOOL_RESULT_UNAVAILABLE,
      /(limit|unable|cannot|can't|couldn't|could not|not able)/i,
    )
    console.log(`  → ${refused.filter(Boolean).length}/${refused.length} explained the failure\n`)
  } else {
    console.log('  SKIP   no tool call was ever produced, so there is nothing to answer\n')
  }

  console.log('phase 5 — tool_calls over a streaming request')
  const streamed = await probeStreaming(TRIGGER_CASES[0])
  const streamedOk = streamed.filter((o) => o.ok).length
  const forms = [...new Set(streamed.filter((o) => o.ok).map((o) => o.form))]
  console.log(`  → ${streamedOk}/${streamed.length} produced a usable tool call over SSE\n`)

  const rate = attempts > 0 ? Math.round((hits / attempts) * 100) : 0
  console.log('--- summary ---')
  console.log(`  trigger hit rate:     ${hits}/${attempts} (${rate}%)`)
  console.log(`  restraint (quiet):    ${quiet}/${restraint.length}`)
  console.log(`  round trip (success): ${ok.filter(Boolean).length}/${ok.length}`)
  console.log(`  round trip (refusal): ${refused.filter(Boolean).length}/${refused.length}`)
  console.log(
    `  streaming tool_calls: ${streamedOk}/${streamed.length}` +
      (forms.length > 0 ? ` (form: ${forms.join(', ')})` : ''),
  )

  // A clean sweep is the bar. Tool calling that fires 60% of the time would
  // ship a feature that silently does nothing four times in ten, which is
  // worse than not having it — see the note in DOCS.md.
  const clean =
    hits === attempts &&
    quiet === restraint.length &&
    ok.length > 0 &&
    ok.every(Boolean) &&
    refused.length > 0 &&
    refused.every(Boolean)
  console.log(
    clean
      ? `\ntools: yes — ${MODEL} calls generate_image reliably through ${BASE_URL}.`
      : '\ntools: unreliable — do not wire generate_image in on these numbers.',
  )
  // Informational, and deliberately outside `clean`: this decides *how* the
  // Worker asks, not *whether* it can. See the phase 5 note at the top.
  console.log(
    streamedOk === streamed.length
      ? 'streaming: yes — the tool-decision leg can keep `stream: true`.'
      : 'streaming: no — the tool-decision leg must be sent non-streamed.',
  )
  process.exit(clean ? 0 : 1)
}

main().catch((err) => {
  console.error('tools: error —', err.message)
  process.exit(1)
})
