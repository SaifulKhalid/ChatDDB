#!/usr/bin/env node

/**
 * Probes the OpenRouter free tier — the backup text gateway.
 *
 * Three questions, in order, and only the third can fail the probe:
 *
 *   1. catalog  which `:free` models exist right now, with context length and
 *               image-input support. Free ids rotate — the catalogue this
 *               prints today is not the one that will be printed next quarter,
 *               which is why `OPENROUTER_MODEL` is a var and not a constant.
 *   2. choose   whether the configured/default model id still exists in the
 *               catalogue, and whether it takes images.
 *   3. stream   a real streaming completion against that model, with the exact
 *               request shape `worker/provider.ts` sends (`stream: true`,
 *               `max_tokens`, attribution headers). A backup that cannot
 *               complete a round trip is a `chainFor` entry that will fail in
 *               production *after* the primary already has — the worst possible
 *               moment to discover it.
 *
 * The catalog phase is also how `OPENROUTER_VISION` gets its value: the printed
 * `input: image` column is the fact to check before setting that var to
 * `true`, which is what keeps image turns crossing to the backup.
 *
 * Usage:
 *   npm run probe:openrouter
 *   OPENROUTER_MODEL=some/model:free npm run probe:openrouter
 *
 * Reads OPENROUTER_API_KEY and related vars from environment / .dev.vars.
 * Exits non-zero only when the streaming round trip fails — a thinner catalogue
 * is a fact to look at, not a broken deployment.
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

const API_KEY = process.env.OPENROUTER_API_KEY
if (!API_KEY || API_KEY === 'sk-or-replace-me') {
  console.error('error: OPENROUTER_API_KEY is not set (.dev.vars or environment)')
  process.exit(1)
}

const BASE_URL = (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '')
const MODEL = process.env.OPENROUTER_MODEL ?? 'z-ai/glm-5.2:free'

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
  // The same attribution headers `upstreamHeaders` sends for the openrouter
  // provider — the probe should see exactly what production sees.
  'HTTP-Referer': 'https://chatddb.app',
  'X-Title': 'ChatDDB',
}

// ---------------------------------------------------------------------------
// Phase 1 — catalog
// ---------------------------------------------------------------------------

console.log(`\nOpenRouter probe — ${BASE_URL}`)
console.log(`configured model: ${MODEL}\n`)

let catalog = []
try {
  const res = await fetch(`${BASE_URL}/models`, { headers })
  if (!res.ok) {
    console.error(`error: catalog fetch failed (HTTP ${res.status})`)
    console.error((await res.text()).slice(0, 400))
    process.exit(1)
  }
  const payload = await res.json()
  catalog = Array.isArray(payload?.data) ? payload.data : []
} catch (err) {
  console.error(`error: catalog fetch threw: ${err?.message ?? err}`)
  process.exit(1)
}

const free = catalog
  .map((m) => {
    const inputModalities = m?.architecture?.input_modality ?? []
    return {
      id: m.id,
      context: m?.top_provider?.context_length ?? m?.context_length ?? '?',
      // The OpenRouter shape is `input_modality: ["text", "image"]` — a string
      // array on some entries and an object elsewhere; take both shapes.
      image: Array.isArray(inputModalities)
        ? inputModalities.includes('image')
        : Boolean(inputModalities?.image),
    }
  })
  .filter((m) => typeof m.id === 'string' && m.id.endsWith(':free'))

if (free.length === 0) {
  console.log('  no :free models in the catalog (they rotate — check openrouter.ai/models)')
} else {
  console.log(`  ${free.length} free model(s):`)
  for (const m of free) {
    console.log(`    ${m.id}  ctx=${m.context}  input:image=${m.image ? 'yes' : 'no'}`)
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — is the configured model still there?
// ---------------------------------------------------------------------------

const chosen = catalog.find((m) => m?.id === MODEL)
console.log(`\nchosen model ${MODEL}:`)
if (!chosen) {
  console.log('  NOT in the catalog — OPENROUTER_MODEL needs updating (see the list above)')
  process.exit(1)
}
const chosenImage = Array.isArray(chosen?.architecture?.input_modality)
  ? chosen.architecture.input_modality.includes('image')
  : Boolean(chosen?.architecture?.input_modality?.image)
console.log(`  context: ${chosen?.top_provider?.context_length ?? chosen?.context_length ?? '?'}`)
console.log(`  image input: ${chosenImage ? 'yes' : 'no'}`)
if (chosenImage) {
  console.log('  -> set OPENROUTER_VISION=true in wrangler.jsonc / .dev.vars to let image turns cross over')
} else {
  console.log('  -> image turns will NOT cross to this model (OPENROUTER_VISION unset)')
}

// ---------------------------------------------------------------------------
// Phase 3 — streaming round trip
// ---------------------------------------------------------------------------

console.log('\nstreaming completion:')
let frames = 0
let text = ''
try {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with exactly: backup gateway ok' }],
      stream: true,
      // The request shape `worker/provider.ts` builds: `max_tokens` by default,
      // and no `stream_options` — the probe proves the minimal production body.
      max_tokens: 32,
    }),
  })
  if (!res.ok) {
    console.error(`  FAIL HTTP ${res.status}`)
    console.error((await res.text()).slice(0, 400))
    process.exit(1)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const frame = JSON.parse(data)
        const delta = frame?.choices?.[0]?.delta?.content
        if (typeof delta === 'string') text += delta
        frames++
      } catch {
        /* keep-alive or comment */
      }
    }
  }
} catch (err) {
  console.error(`  FAIL threw: ${err?.message ?? err}`)
  process.exit(1)
}

console.log(`  frames: ${frames}`)
console.log(`  text: ${JSON.stringify(text.slice(0, 120))}`)
if (frames === 0 || !text.trim()) {
  console.error('  FAIL — no usable content frames came back')
  process.exit(1)
}
console.log('  ok')
