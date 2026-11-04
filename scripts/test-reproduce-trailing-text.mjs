#!/usr/bin/env node

/**
 * Unit test to reproduce the trailing duplicate text bug:
 * Demonstrates that feeding raw AgentRouter Responses-API SSE frames to the
 * un-normalized parser produces duplicate text because `response.output_text.done`
 * contains `text: "..."` which gets re-emitted as if it were a new delta.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rawSse = readFileSync(resolve(__dirname, 'fixtures', 'agentrouter_text.sse'), 'utf-8')

// The OLD extractContent logic from commit 9e9ec9d
function oldExtractContent(chunk) {
  const directDelta = chunk.delta
  if (typeof directDelta === 'string' && directDelta.length > 0) return directDelta
  if (typeof directDelta === 'object' && directDelta !== null) {
    const text = directDelta.content ?? directDelta.text
    if (typeof text === 'string' && text.length > 0) return text
  }

  const directText = chunk.text
  if (typeof directText === 'string' && directText.length > 0) return directText

  const choice = chunk.choices?.[0]
  if (!choice) return null
  const delta = choice.delta?.content
  if (typeof delta === 'string' && delta.length > 0) return delta
  const whole = choice.message?.content
  if (typeof whole === 'string' && whole.length > 0) return whole
  return null
}

console.log('Testing oldExtractContent against raw AgentRouter stream...')

let accumulated = ''
let doneEventsSeen = 0

for (const line of rawSse.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) continue
  const payload = trimmed.slice(5).trim()
  if (!payload || payload === '[DONE]') continue

  let chunk = null
  try {
    chunk = JSON.parse(payload)
  } catch {
    continue
  }

  if (chunk.type === 'response.output_text.done') {
    doneEventsSeen++
  }

  const content = oldExtractContent(chunk)
  if (content) {
    accumulated += content
  }
}

console.log(`Saw ${doneEventsSeen} output_text.done event(s)`)
console.log(`Total accumulated text length: ${accumulated.length}`)

// In the captured stream, the 5 names are generated.
// Because output_text.done has text, it gets appended a SECOND time!
const firstOccurrence = accumulated.indexOf('1. **WeekendForge**')
const secondOccurrence = accumulated.indexOf('1. **WeekendForge**', firstOccurrence + 1)

assert(secondOccurrence > 0, 'Reproduced: The full text was appended twice!')
console.log('✓ Successfully reproduced trailing duplicate text bug!')
console.log(`First occurrence at index ${firstOccurrence}, second occurrence at index ${secondOccurrence}`)
