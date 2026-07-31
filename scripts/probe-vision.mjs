#!/usr/bin/env node

/**
 * Probes whether the configured upstream model supports vision inputs.
 *
 * Posts a 1x1 PNG as an image_url content part to gpt-5.6-sol and reports
 * whether the model accepted it.
 *
 * Usage:
 *   node scripts/probe-vision.mjs
 *
 * Reads AGENTROUTER_API_KEY and related vars from environment / .dev.vars.
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

// A 1×1 red PNG as a base64 data URI
const RED_DOT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

async function main() {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'claude-cli/2.1.158 (external, sdk-cli)',
    },
    body: JSON.stringify({
      model: MODEL,
      max_completion_tokens: 10,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: RED_DOT } },
            { type: 'text', text: 'What color is this image?' },
          ],
        },
      ],
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    // A 400 with "image_url" in the message means the model does not
    // support vision inputs.
    if (res.status === 400 && text.toLowerCase().includes('image_url')) {
      console.log(`vision: no — ${text.slice(0, 200)}`)
      process.exit(0)
    }
    console.error(`vision: error (${res.status}) — ${text.slice(0, 300)}`)
    process.exit(1)
  }

  const body = await res.json()
  const content = body?.choices?.[0]?.message?.content ?? ''
  console.log(`vision: yes — "${content.slice(0, 100)}"`)
}

main().catch((err) => {
  console.error('vision: error —', err.message)
  process.exit(1)
})
