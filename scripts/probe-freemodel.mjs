#!/usr/bin/env node

/**
 * Probes freemodel.dev, the fallback gateway, for the body shape it accepts.
 *
 * The Worker's upstream client was written against AgentRouter's `gpt-5.6-sol`,
 * a reasoning model: it sends `max_completion_tokens` rather than `max_tokens`,
 * a `reasoning_effort`, and no `temperature`. Whether freemodel's `gpt-5.5`
 * agrees on any of that is not documented, so it is measured here instead of
 * guessed. The answers become `tokenParam` and `sendReasoningEffort` in
 * `worker/failover.ts`.
 *
 * Usage:
 *   npm run probe:freemodel
 *
 * Reads FREEMODEL_API_KEY and related vars from environment / .dev.vars.
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

const API_KEY = process.env.FREEMODEL_API_KEY
if (!API_KEY) {
  console.error('error: FREEMODEL_API_KEY is not set (add it to .dev.vars)')
  process.exit(1)
}

const BASE_URL = process.env.FREEMODEL_BASE_URL ?? 'https://freemodel.dev/v1'
const MODEL = process.env.FREEMODEL_MODEL ?? 'gpt-5.5'

const results = []
function record(label, verdict, detail) {
  results.push({ label, verdict, detail })
  const mark = verdict === 'ok' ? 'PASS' : verdict === 'no' ? 'NO  ' : 'FAIL'
  console.log(`${mark}  ${label}${detail ? ` — ${detail}` : ''}`)
}

function post(body, extra = {}) {
  return fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      ...extra,
    },
    body: JSON.stringify(body),
  })
}

const HELLO = [{ role: 'user', content: 'Reply with the single word: ok' }]

/** 1. Is the fallback model actually in the catalogue? */
async function probeCatalogue() {
  const res = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  })
  if (!res.ok) {
    record('catalogue', 'fail', `HTTP ${res.status}`)
    return
  }
  const body = await res.json()
  const ids = (body?.data ?? []).map((m) => m.id)
  if (ids.includes(MODEL)) record('catalogue', 'ok', `${MODEL} present of ${ids.length}`)
  else record('catalogue', 'fail', `${MODEL} MISSING; has ${ids.join(', ')}`)
}

/**
 * 2. Which token-cap parameter does it take?
 *
 * Tried in the order the Worker prefers, so a gateway accepting both keeps the
 * same body it already sends to AgentRouter.
 */
async function probeTokenParam() {
  for (const param of ['max_completion_tokens', 'max_tokens']) {
    const res = await post({ model: MODEL, messages: HELLO, [param]: 16 })
    if (res.ok) {
      record('tokenParam', 'ok', param)
      return param
    }
    const text = await res.text()
    console.log(`      ${param}: HTTP ${res.status} ${text.slice(0, 160)}`)
  }
  record('tokenParam', 'fail', 'neither parameter accepted')
  return null
}

/** 3. Does it accept `reasoning_effort`, or reject the whole request over it? */
async function probeReasoningEffort(tokenParam) {
  const res = await post({
    model: MODEL,
    messages: HELLO,
    [tokenParam]: 16,
    reasoning_effort: 'low',
  })
  if (res.ok) {
    record('reasoning_effort', 'ok', 'accepted — sendReasoningEffort: true')
    return true
  }
  const text = await res.text()
  record('reasoning_effort', 'no', `HTTP ${res.status} — sendReasoningEffort: false`)
  console.log(`      ${text.slice(0, 200)}`)
  return false
}

/**
 * 4 & 5. Stream one completion, and check both that the frames are the shape
 * `pumpEventStream` in worker/sse.ts parses, and whether a usage block arrives.
 *
 * The frame shape matters more than the usage block: `token_source` already
 * records an estimate when upstream stays silent, but a frame this Worker
 * cannot parse would mean an empty reply.
 */
async function probeStream(tokenParam, sendEffort) {
  const res = await post({
    model: MODEL,
    messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
    [tokenParam]: 128,
    stream: true,
    stream_options: { include_usage: true },
    ...(sendEffort ? { reasoning_effort: 'low' } : {}),
  })

  if (!res.ok || !res.body) {
    record('stream', 'fail', `HTTP ${res.status} ${(await res.text()).slice(0, 160)}`)
    return
  }

  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    // Not fatal: toClientStream falls back to pumpJsonBody on a non-SSE body,
    // which is exactly how AgentRouter's buffered responses are handled.
    record('stream', 'no', `content-type is "${contentType}" — pumpJsonBody path`)
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let frames = 0
  let text = ''
  let usage = null
  let sawDone = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') {
        sawDone = true
        continue
      }
      if (!payload) continue
      let chunk
      try {
        chunk = JSON.parse(payload)
      } catch {
        continue
      }
      frames++
      const delta = chunk?.choices?.[0]?.delta?.content
      if (typeof delta === 'string') text += delta
      if (chunk?.usage) usage = chunk.usage
    }
  }

  if (text.length > 0) {
    record('stream', 'ok', `${frames} frames, [DONE]=${sawDone}, "${text.slice(0, 40).replace(/\n/g, ' ')}"`)
  } else {
    record('stream', 'fail', `${frames} frames but no delta.content — sse.ts would see an empty reply`)
  }

  if (usage) record('include_usage', 'ok', JSON.stringify(usage))
  else record('include_usage', 'no', 'no usage block — token_source will be "estimate"')
}

async function main() {
  console.log(`probing ${BASE_URL} with model ${MODEL}\n`)

  await probeCatalogue()
  const tokenParam = await probeTokenParam()
  if (!tokenParam) {
    console.log('\ncannot continue without a working token parameter')
    process.exit(1)
  }
  const sendEffort = await probeReasoningEffort(tokenParam)
  await probeStream(tokenParam, sendEffort)

  console.log('\n--- config for worker/failover.ts ---')
  console.log(`  tokenParam:          '${tokenParam}'`)
  console.log(`  sendReasoningEffort: ${sendEffort}`)

  process.exit(results.some((r) => r.verdict === 'fail') ? 1 : 0)
}

main().catch((err) => {
  console.error('probe failed —', err.message)
  process.exit(1)
})
