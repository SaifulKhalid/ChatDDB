#!/usr/bin/env node

/**
 * Focused CodeCraft Provider Smoke Test.
 *
 * Evaluates:
 *   1. CODECRAFT_API_KEY presence
 *   2. GET /v1/models network connectivity
 *   3. ChatGPT 5.6 (gpt-5.6-sol) minimal chat completion
 *   4. Gemini 3.7 (gemini-3.7-flash) minimal chat completion
 *   5. Claude 5 (claude-opus-5) minimal chat completion
 *   6. ChatGPT 5.6 SSE streaming
 *
 * NEVER logs or prints:
 *   - CODECRAFT_API_KEY
 *   - Authorization header
 *
 * Reports only PASS/FAIL, HTTP status, and sanitized error types.
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const devVars = resolve(__dirname, '..', '.dev.vars')

// Load from .dev.vars if present
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

const rawKey = process.env.CODECRAFT_API_KEY?.trim()
const apiKey = rawKey
  ? rawKey
      .replace(/^["']|["']$/g, '')
      .replace(/^Bearer\s+/i, '')
      .trim()
  : undefined

const BASE_URL = (process.env.CODECRAFT_BASE_URL?.trim() || 'https://codecraftapi.com/v1').replace(/\/+$/, '')
const CHAT_URL = `${BASE_URL}/chat/completions`
const MODELS_URL = `${BASE_URL}/models`

let passed = 0
let failed = 0

function report(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  PASS: ${name}${detail ? ` (${detail})` : ''}`)
  } else {
    failed++
    console.log(`  FAIL: ${name}${detail ? ` (${detail})` : ''}`)
  }
}

async function main() {
  console.log('=== CodeCraft Focused Provider Smoke Test ===\n')

  // 1. Key presence
  const hasKey = Boolean(apiKey && apiKey !== 'cc-replace-me')
  report('1. CODECRAFT_API_KEY presence', hasKey, hasKey ? 'key configured' : 'missing or placeholder')

  // 2. Network connectivity to GET /v1/models
  let networkOk = false
  try {
    const res = await fetch(MODELS_URL, {
      headers: hasKey ? { Authorization: `Bearer ${apiKey}` } : {},
    })
    networkOk = res.ok
    report('2. GET /v1/models connectivity', res.ok, `HTTP ${res.status}`)
    if (res.ok) {
      const data = await res.json().catch(() => ({}))
      const modelCount = Array.isArray(data?.data) ? data.data.length : 0
      console.log(`     Discovered ${modelCount} models from CodeCraft catalog`)
    }
  } catch (err) {
    report('2. GET /v1/models connectivity', false, err instanceof Error ? err.message : 'fetch failed')
  }

  if (!hasKey) {
    console.log('\nCannot proceed with authenticated completion tests: CODECRAFT_API_KEY is not configured.')
    console.log(`Result: ${passed} passed, ${failed} failed.`)
    return
  }

  // Helper for chat completions
  async function postChat(payload) {
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(payload.stream ? { Accept: 'text/event-stream' } : {}),
        },
        body: JSON.stringify(payload),
      })
      const text = await res.text()
      return { ok: res.ok, status: res.status, text }
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : 'request failed' }
    }
  }

  // 3. ChatGPT 5.6 (gpt-5.6-sol)
  const gptRes = await postChat({
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'Reply with exactly: CodeCraft ChatGPT works' }],
    max_tokens: 16,
    stream: false,
  })
  report('3. ChatGPT 5.6 (gpt-5.6-sol) completion', gptRes.ok, `HTTP ${gptRes.status}`)

  // 4. Gemini 3.7 (gemini-3.7-flash)
  const geminiRes = await postChat({
    model: 'gemini-3.7-flash',
    messages: [{ role: 'user', content: 'Reply with exactly: CodeCraft Gemini works' }],
    max_tokens: 16,
    stream: false,
  })
  report('4. Gemini 3.7 (gemini-3.7-flash) completion', geminiRes.ok, `HTTP ${geminiRes.status}`)

  // 5. Claude 5 (claude-opus-5)
  const claudeRes = await postChat({
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'Reply with exactly: CodeCraft Claude works' }],
    max_tokens: 16,
    stream: false,
  })
  report('5. Claude 5 (claude-opus-5) completion', claudeRes.ok, `HTTP ${claudeRes.status}`)

  // 6. ChatGPT 5.6 streaming
  const streamRes = await postChat({
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'Reply with exactly: CodeCraft stream works' }],
    max_tokens: 16,
    stream: true,
  })
  const streamOk = streamRes.ok && streamRes.text.includes('data:')
  report('6. ChatGPT 5.6 SSE streaming', streamOk, `HTTP ${streamRes.status}`)

  console.log(`\nResult: ${passed} passed, ${failed} failed.`)
}

main().catch((err) => {
  console.error('Unexpected smoke test failure:', err)
  process.exit(1)
})
