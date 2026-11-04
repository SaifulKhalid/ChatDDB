#!/usr/bin/env node

/**
 * Captures raw SSE streams directly from upstream providers:
 * 1. AgentRouter (Responses API) -> text, tool, image
 * 2. ApiNex (Chat Completions)   -> text, tool, image
 *
 * Saves fixtures into scripts/fixtures/*.sse
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const devVars = resolve(__dirname, '..', '.dev.vars')

if (existsSync(devVars)) {
  const text = readFileSync(devVars, 'utf-8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq > 0) {
      const k = trimmed.slice(0, eq).trim()
      const v = trimmed.slice(eq + 1).trim()
      if (!process.env[k]) process.env[k] = v
    }
  }
}

const AGENTROUTER_KEY = process.env.AGENTROUTER_API_KEY
const APINEX_KEY = process.env.APINEX_API_KEY

if (!AGENTROUTER_KEY || !APINEX_KEY) {
  console.error('Missing AGENTROUTER_API_KEY or APINEX_API_KEY in environment or .dev.vars')
  process.exit(1)
}

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const IMAGE_TOOL_OPENAI = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: 'Generate an image and attach it to your reply. Call this when asked to draw or visualize.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Description of the image to generate' },
      },
      required: ['prompt'],
    },
  },
}

const IMAGE_TOOL_RESPONSES = {
  type: 'function',
  name: 'generate_image',
  description: 'Generate an image and attach it to your reply. Call this when asked to draw or visualize.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Description of the image to generate' },
    },
    required: ['prompt'],
  },
}

async function captureStream(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`HTTP ${res.status}: ${errText}`)
  }
  return await res.text()
}

async function run() {
  const fixturesDir = resolve(__dirname, 'fixtures')

  console.log('--- 1. Capturing AgentRouter (Responses API) ---')

  // 1a. Text turn (Chat 2 prompt: "Brainstorm five names for a weekend coding project.")
  console.log('Capturing agentrouter_text.sse...')
  const arText = await captureStream(
    'https://agentrouter.org/v1/responses',
    {
      Authorization: `Bearer ${AGENTROUTER_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': 'codex_cli_rs/0.40.0',
    },
    {
      model: 'gpt-6.1-sol',
      stream: true,
      instructions: 'You are ChatDDB, a helpful AI assistant.',
      input: [{ role: 'user', content: 'Brainstorm five names for a weekend coding project.' }],
    },
  )
  writeFileSync(resolve(fixturesDir, 'agentrouter_text.sse'), arText, 'utf-8')
  console.log(`Saved agentrouter_text.sse (${arText.length} bytes)`)

  // 1b. Tool turn
  console.log('Capturing agentrouter_tool.sse...')
  try {
    const arTool = await captureStream(
      'https://agentrouter.org/v1/responses',
      {
        Authorization: `Bearer ${AGENTROUTER_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'User-Agent': 'codex_cli_rs/0.40.0',
      },
      {
        model: 'gpt-6.1-sol',
        stream: true,
        instructions: 'You are ChatDDB. Call generate_image when asked to draw.',
        input: [{ role: 'user', content: 'Draw a diagram of a three-tier web architecture.' }],
        tools: [IMAGE_TOOL_RESPONSES],
      },
    )
    writeFileSync(resolve(fixturesDir, 'agentrouter_tool.sse'), arTool, 'utf-8')
    console.log(`Saved agentrouter_tool.sse (${arTool.length} bytes)`)
  } catch (err) {
    console.warn(`AgentRouter tool turn: ${err.message}`)
    writeFileSync(resolve(fixturesDir, 'agentrouter_tool_error.txt'), err.message, 'utf-8')
  }

  // 1c. Image turn
  console.log('Capturing agentrouter_image.sse...')
  try {
    const arImage = await captureStream(
      'https://agentrouter.org/v1/responses',
      {
        Authorization: `Bearer ${AGENTROUTER_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'User-Agent': 'codex_cli_rs/0.40.0',
      },
      {
        model: 'gpt-6.1-sol',
        stream: true,
        instructions: 'You are ChatDDB.',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Describe what you see in this image.' },
              { type: 'input_image', image_url: TINY_PNG_DATA_URL },
            ],
          },
        ],
      },
    )
    writeFileSync(resolve(fixturesDir, 'agentrouter_image.sse'), arImage, 'utf-8')
    console.log(`Saved agentrouter_image.sse (${arImage.length} bytes)`)
  } catch (err) {
    console.warn(`AgentRouter image turn: ${err.message}`)
    writeFileSync(resolve(fixturesDir, 'agentrouter_image_error.txt'), err.message, 'utf-8')
  }

  console.log('--- 2. Capturing ApiNex (Chat Completions API) ---')

  // 2a. Text turn
  console.log('Capturing apinex_text.sse...')
  const apText = await captureStream(
    'https://api.apinex.bond/v1/chat/completions',
    {
      Authorization: `Bearer ${APINEX_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    {
      model: 'gpt-6.1-sol',
      stream: true,
      messages: [
        { role: 'system', content: 'You are ChatDDB, a helpful AI assistant.' },
        { role: 'user', content: 'Brainstorm five names for a weekend coding project.' },
      ],
    },
  )
  writeFileSync(resolve(fixturesDir, 'apinex_text.sse'), apText, 'utf-8')
  console.log(`Saved apinex_text.sse (${apText.length} bytes)`)

  // 2b. Tool turn
  console.log('Capturing apinex_tool.sse...')
  const apTool = await captureStream(
    'https://api.apinex.bond/v1/chat/completions',
    {
      Authorization: `Bearer ${APINEX_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    {
      model: 'gpt-6.1-sol',
      stream: true,
      messages: [
        { role: 'system', content: 'You are ChatDDB. Call generate_image when asked to draw.' },
        { role: 'user', content: 'Draw a diagram of a three-tier web architecture.' },
      ],
      tools: [IMAGE_TOOL_OPENAI],
      tool_choice: 'auto',
    },
  )
  writeFileSync(resolve(fixturesDir, 'apinex_tool.sse'), apTool, 'utf-8')
  console.log(`Saved apinex_tool.sse (${apTool.length} bytes)`)

  // 2c. Image turn
  console.log('Capturing apinex_image.sse...')
  const apImage = await captureStream(
    'https://api.apinex.bond/v1/chat/completions',
    {
      Authorization: `Bearer ${APINEX_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    {
      model: 'gpt-6.1-sol',
      stream: true,
      messages: [
        { role: 'system', content: 'You are ChatDDB.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe what you see in this image.' },
            { type: 'image_url', image_url: { url: TINY_PNG_DATA_URL } },
          ],
        },
      ],
    },
  )
  writeFileSync(resolve(fixturesDir, 'apinex_image.sse'), apImage, 'utf-8')
  console.log(`Saved apinex_image.sse (${apImage.length} bytes)`)

  console.log('All fixtures captured successfully.')
}

run().catch((err) => {
  console.error('Capture failed:', err)
  process.exit(1)
})
