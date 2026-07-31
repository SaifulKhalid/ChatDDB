#!/usr/bin/env node

/**
 * Probes whether AgentRouter forwards multimodal content parts to the model.
 *
 * This is the check that certifies `vision` in `worker/models.ts`, so it has to
 * be hard to pass by accident. An earlier version posted a 1x1 PNG and asked
 * what colour it was; the model answered confidently and *wrongly*, which reads
 * as a pass. A 1x1 image is also small enough that a gateway could drop the part
 * entirely without the reply looking any different.
 *
 * So: generate images with a known answer, and require the model to say it.
 * The split case is the one that matters — a model guessing plausible colour
 * words cannot also get left/right ordering right.
 *
 * Usage:
 *   node scripts/probe-vision.mjs
 *
 * Reads AGENTROUTER_API_KEY and related vars from environment / .dev.vars.
 * Exits non-zero unless every case passes.
 */

import { readFileSync, existsSync } from 'fs'
import { deflateSync } from 'zlib'
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

// ---------------------------------------------------------------------------
// A minimal PNG encoder, so the probe depends on nothing but Node.
// Truecolour (8-bit RGB), one zlib stream, no row filtering.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

/** `pixel(x, y)` returns `[r, g, b]`. */
function png(width, height, pixel) {
  const stride = 1 + width * 3
  const raw = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    raw[row] = 0 // filter type: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      raw[row + 1 + x * 3] = r
      raw[row + 2 + x * 3] = g
      raw[row + 3 + x * 3] = b
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const solid = (size, colour) => png(size, size, () => colour)
const splitLeftRight = (size, left, right) => png(size, size, (x) => (x < size / 2 ? left : right))

const ONE_WORD = 'Reply with exactly one word: the dominant color of this image.'

const CASES = [
  {
    name: 'solid blue',
    image: solid(128, [0, 0, 255]),
    question: ONE_WORD,
    expect: /blue/i,
  },
  {
    name: 'solid yellow',
    image: solid(128, [255, 255, 0]),
    question: ONE_WORD,
    expect: /yellow/i,
  },
  {
    // The load-bearing case: colour *and* position, which guessing cannot fake.
    name: 'split red|green',
    image: splitLeftRight(128, [255, 0, 0], [0, 200, 0]),
    question:
      'This image has two vertical halves. Reply with exactly two words: ' +
      'the left half color, then the right half color.',
    expect: /red[\s,]+green/i,
  },
]

async function ask({ image, question }) {
  const url = `data:image/png;base64,${image.toString('base64')}`
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'claude-cli/2.1.158 (external, sdk-cli)',
    },
    body: JSON.stringify({
      model: MODEL,
      // Generous, not tight: gpt-5.6-sol is a reasoning model, and a small cap
      // gets spent on reasoning tokens leaving an empty `content` — which would
      // look like a vision failure and is not one.
      max_completion_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url } },
            { type: 'text', text: question },
          ],
        },
      ],
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    // A 400 naming `image_url` is the gateway saying it will not carry the part.
    const refused = res.status === 400 && text.toLowerCase().includes('image_url')
    return { ok: false, refused, detail: `HTTP ${res.status} — ${text.slice(0, 200)}` }
  }

  const body = await res.json()
  return { ok: true, answer: (body?.choices?.[0]?.message?.content ?? '').trim() }
}

async function main() {
  let failures = 0

  for (const testCase of CASES) {
    const result = await ask(testCase)

    if (!result.ok) {
      console.log(
        result.refused
          ? `vision: no — ${testCase.name}: ${result.detail}`
          : `vision: error — ${testCase.name}: ${result.detail}`,
      )
      process.exit(1)
    }

    const passed = testCase.expect.test(result.answer)
    if (!passed) failures++
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${testCase.name} -> "${result.answer.slice(0, 120)}"`)
  }

  if (failures > 0) {
    // Reaching here means the parts were accepted but not understood: the model
    // answered about images it evidently could not see. Treat that as no vision.
    console.log(`\nvision: no — ${failures}/${CASES.length} case(s) answered incorrectly.`)
    console.log('Leave `vision: false` in worker/models.ts.')
    process.exit(1)
  }

  console.log(`\nvision: yes — all ${CASES.length} cases correct on ${MODEL}.`)
}

main().catch((err) => {
  console.error('vision: error —', err.message)
  process.exit(1)
})
