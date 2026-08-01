#!/usr/bin/env node

/**
 * Probes whether `gpt-5.6-sol` can *draw* a correct engineering figure as SVG.
 *
 * This is the check that has to pass before a `draw_diagram` tool is wired into
 * `worker/routes/chat.ts`, and it exists because the feature it would replace
 * failed for a reason no amount of provider-shopping fixes. Asked to "draw pole
 * and zero for this equation", flux-1-schnell produced a vertical stroke, a
 * stray arrow, and the handwriting-shaped noise "= 2". Diffusion models have no
 * symbolic model of an axis; they generate texture that resembles a diagram.
 *
 * The proposed replacement inverts that: the model *computes* the figure and
 * emits SVG source, which the browser renders deterministically. That is a
 * strictly harder demand on the language model, though, so the assumption needs
 * measuring before anything is built on it — the same discipline
 * `scripts/probe-tool-calling.mjs` applied to the gateway.
 *
 * ## Why this probe renders, instead of only parsing
 *
 * Structural assertions are cheap and necessary but they are not sufficient. An
 * SVG can parse, carry a `viewBox`, and hold a dozen `<text>` nodes while
 * placing every label on top of every other one, or drawing a pole at the wrong
 * coordinate. No string check catches that. So each candidate is rendered
 * headlessly to PNG in `shots/svg-probe/`, and the verdict on *quality* is made
 * by looking at the pictures. This script reports what it can prove and is
 * explicit that the rest is a visual judgement.
 *
 * ## What is asserted per candidate — phase 1, quality
 *
 *   parses      well-formed XML with an `<svg>` root (a broken figure is worse
 *               than a bitmap: it renders as nothing at all)
 *   viewBox     present, so the figure scales instead of clipping
 *   titled      carries a `<title>`, which `SvgFigure` uses as both the caption
 *               and the accessible name — a figure without one is unreadable to
 *               a screen reader and unnamed when saved
 *   labelled    at least `MIN_LABELS` `<text>` nodes — the exact thing the
 *               diffusion model could not do, so it is the headline metric
 *   themeable   uses `currentColor` somewhere, or is at least not hard-locked to
 *               black-on-white, which would be invisible in the dark theme
 *   inert       no `<script>`, no `on*` handler, no external `href` — recorded
 *               because it also sizes the sanitiser the renderer will need
 *
 * The prompts are the real workload, not toys: ChatDDB's users are mostly
 * engineering students, so this asks for the figures they actually ask for. The
 * first prompt is deliberately the exact transfer function from the 2/10 report.
 *
 * ## Phase 2, restraint
 *
 * Quality is only half the question. Phase 1 asks for a figure and measures what
 * comes back; the shipped prompt asks for a figure *when one is warranted*, and a
 * model that draws for every question is worse than one that draws for none —
 * every needless figure is latency, output tokens and visual noise on an answer
 * that wanted a paragraph.
 *
 * So phase 2 sends the same system prompt over a mixed workload and asserts only
 * one thing per case: whether a ```` ```svg ```` fence appears. Half the cases
 * should draw, half should not, and the "should not" half is deliberately made of
 * things that are adjacent to drawing — a derivation, a table, a code request —
 * rather than obviously unrelated trivia, because those are the ones a
 * trigger-happy model gets wrong. This mirrors phase 5 of
 * `scripts/probe-tool-calling.mjs`, which had to establish the same property for
 * `generate_image`.
 *
 * Usage:
 *   node scripts/probe-svg-diagrams.mjs
 *   RUNS=3 node scripts/probe-svg-diagrams.mjs
 *   NO_RENDER=1 node scripts/probe-svg-diagrams.mjs   # skip the PNG pass
 *   PHASE=1 node scripts/probe-svg-diagrams.mjs       # quality only
 *   PHASE=2 node scripts/probe-svg-diagrams.mjs       # restraint only
 *
 * Reads AGENTROUTER_API_KEY and related vars from environment / .dev.vars.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// Load .dev.vars if present — same loader as the sibling probes.
const devVars = resolve(ROOT, '.dev.vars')
if (existsSync(devVars)) {
  for (const line of readFileSync(devVars, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim()
      if (!process.env[key]) process.env[key] = trimmed.slice(eq + 1).trim()
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
const RUNS = Number.parseInt(process.env.RUNS ?? '2', 10)
const NO_RENDER = process.env.NO_RENDER === '1'
const PHASE = process.env.PHASE ?? 'all'
/** A figure with fewer labels than this is a drawing, not a diagram. */
const MIN_LABELS = 4

const OUT_DIR = resolve(ROOT, 'shots', 'svg-probe')

/**
 * The system prompt, mirroring the shipped `DIAGRAM_CLAUSE` in
 * `worker/routes/chat.ts`.
 *
 * Written out here rather than imported, for the same reason the sibling probe
 * keeps its tool schema literal: importing the real string would make the probe
 * pass by construction if someone later weakened it. Keep the two in step by
 * hand — a divergence is exactly what this is meant to catch.
 *
 * Every rule is here because its absence produced a specific defect in an
 * earlier run: unreadable dark-theme figures (no `currentColor`), clipped
 * figures (no `viewBox`), labels colliding with the marks they name (no offset
 * instruction), 16px text inside a 300-unit viewBox (no explicit font-size).
 *
 * Note what changed when this went from a research spec to a shipped clause. The
 * first version said "reply with ONLY a fenced block, no prose" — fine for
 * measuring drawing ability, wrong for production, where a figure arrives inside
 * a normal answer. Measuring the earlier wording would have told us nothing
 * about restraint, since a prompt that forbids prose cannot decline to draw.
 */
const DIAGRAM_SPEC = [
  'You are ChatDDB, a helpful, knowledgeable AI assistant.',
  'Answer accurately and get to the point; expand only when the question needs it.',
  'Use Markdown — fenced code blocks with a language tag, tables where they help.',
  '',
  'When a figure would carry information your prose cannot — a plot, a circuit, a free-body',
  'diagram, a signal-flow graph, a labelled geometry, a state machine — draw it as SVG inside a',
  '```svg fenced code block. It is rendered as a real figure, not printed as code.',
  'Draw only when the figure is the answer or a necessary part of it. Never to decorate, and never',
  'for something Markdown already renders: a table, a list, or an equation.',
  'Most questions need no figure at all.',
  '',
  'When you do draw:',
  '- One `svg` block per figure, holding a single <svg> root with an explicit viewBox.',
  '  Do not set width or height on it.',
  '- Open the root with a <title> naming the figure. It becomes the caption and the accessible name.',
  '- Use stroke="currentColor" and fill="currentColor" for axes, rules and text, so the figure is',
  '  legible in both the light and dark themes. Use a named colour only to pick plotted data out',
  '  from the axes, and never paint a background.',
  '- Give every axis tick marks with numeric labels, and a name.',
  '- Label every plotted feature, offset from the mark it names so nothing overlaps.',
  '- Set font-size explicitly in user units, 11-14 for labels. Never rely on the default.',
  '- No <script>, no event handlers, no <image>, no external references. They are stripped before',
  '  the figure is shown, so a figure that depends on one arrives broken.',
  '- Compute coordinates exactly. A pole at s = -3 belongs at the tick marked -3.',
].join('\n')

/**
 * Real requests from the target audience, hardest-first.
 *
 * `checks` are extra substrings the figure must contain to be *correct* rather
 * than merely well-formed — the coordinates and labels a competent answer cannot
 * omit. They are deliberately weak (presence, not position); position is what the
 * rendered PNGs are for.
 */
const PROMPTS = [
  {
    key: 'pole-zero',
    // The exact request that scored 2/10 against the diffusion model.
    prompt:
      'For H(s) = (s + 2) / ((s + 1)(s + 3)), draw the pole-zero plot in the s-plane. ' +
      'Zero at s = -2. Poles at s = -1 and s = -3. Mark zeros with O and poles with X.',
    checks: ['-1', '-2', '-3'],
  },
  {
    key: 'bode',
    prompt:
      'Draw the straight-line asymptotic Bode magnitude plot for H(s) = 10 / (1 + s/100), ' +
      'with a log frequency axis from 1 to 10000 rad/s and dB on the vertical axis. ' +
      'Show the corner frequency and the -20 dB/decade slope.',
    checks: ['dB', '100'],
  },
  {
    key: 'rc-lowpass',
    prompt:
      'Draw the schematic of a first-order RC low-pass filter: input source on the left, ' +
      'a series resistor R, a shunt capacitor C to ground, and the output taken across C. ' +
      'Label Vin, Vout, R, C and ground.',
    checks: ['R', 'C'],
  },
  {
    key: 'free-body',
    prompt:
      'Draw a free-body diagram of a block of mass m resting on a frictionless incline of ' +
      'angle theta. Show the weight mg acting downward, the normal force N perpendicular to ' +
      'the surface, and the component mg*sin(theta) along the incline.',
    checks: ['N'],
  },
  {
    key: 'z-plane',
    prompt:
      'Draw the z-plane with the unit circle, a pole at z = 0.5 and a pole at z = -0.8, ' +
      'and shade the region of convergence for a causal system. Label the real and ' +
      'imaginary axes and the unit circle.',
    checks: ['0.5'],
  },
]

/**
 * The restraint workload: half want a figure, half do not.
 *
 * The "no" half is the load-bearing half, and it is chosen adversarially. None
 * of these is obviously non-visual — each one is a question a trigger-happy
 * model would happily illustrate:
 *
 *   - a derivation is spatial-sounding but wants LaTeX, which already renders;
 *   - "compare X and Y" is the classic false positive, because the answer has
 *     structure and structure looks drawable. It is a table;
 *   - a code request mentions a data structure, and a linked list is a diagram
 *     in every textbook — but the user asked for code;
 *   - "walk me through" is phrased like a request for a picture and is not one.
 *
 * The "yes" half deliberately includes one implicit case ("I don't understand
 * ..."), because a path that only fires on the literal word "draw" is not much
 * of a feature.
 */
const RESTRAINT = [
  {
    key: 'draw-explicit',
    draw: true,
    prompt: 'Draw the pole-zero plot for H(s) = 1 / (s^2 + 2s + 5).',
  },
  {
    key: 'draw-implicit',
    draw: true,
    prompt:
      "I don't understand how a Wheatstone bridge measures an unknown resistance. Explain it to me.",
  },
  {
    key: 'draw-shape',
    draw: true,
    prompt:
      'What does the step response of a second-order system with damping ratio 0.3 look like, ' +
      'compared with one at 1.0?',
  },
  {
    key: 'quiet-derivation',
    draw: false,
    prompt: 'Derive the quadratic formula by completing the square. Show each step.',
  },
  {
    key: 'quiet-comparison',
    draw: false,
    prompt: 'What are the main differences between TCP and UDP?',
  },
  {
    key: 'quiet-code',
    draw: false,
    prompt: 'Write a Python function that reverses a singly linked list in place.',
  },
  {
    key: 'quiet-prose',
    draw: false,
    prompt: 'Walk me through why the average case of quicksort is O(n log n).',
  },
]

let passed = 0
let failed = 0
const results = []

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`    ✓ ${label}`)
    passed++
  } else {
    console.log(`    ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
  return condition
}

async function ask(prompt) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: DIAGRAM_SPEC },
        { role: 'user', content: prompt },
      ],
      max_completion_tokens: 8192,
    }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(json).slice(0, 300)}`)
  return json.choices?.[0]?.message?.content ?? ''
}

/** Pulls the SVG out of a fenced block, tolerating a bare or unfenced reply. */
function extractSvg(text) {
  const fenced = text.match(/```(?:svg|xml|html)?\s*\n([\s\S]*?)```/)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('<svg')
  const end = body.lastIndexOf('</svg>')
  if (start === -1 || end === -1) return null
  return body.slice(start, end + 6).trim()
}

/**
 * Renders every candidate to PNG so the figures can actually be looked at.
 *
 * Uses the same headless Edge the UI smoke tests use. The wrapper forces a dark
 * background and `color: #e5e7eb`, because the whole point of the
 * `currentColor` rule is that it inherits — a figure that only looks right on
 * white would pass every string check here and be invisible in the app.
 */
async function render(candidates) {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  for (const c of candidates) {
    await page.setContent(
      `<html><body style="margin:0;background:#111827;color:#e5e7eb;
         font-family:system-ui,sans-serif">
         <div style="padding:16px">
           <div style="font:12px system-ui;opacity:.6;margin-bottom:8px">${c.name}</div>
           <div style="max-width:820px">${c.svg}</div>
         </div></body></html>`,
      { waitUntil: 'load' },
    )
    await page.screenshot({ path: resolve(OUT_DIR, `${c.name}.png`), fullPage: true })
    console.log(`  rendered shots/svg-probe/${c.name}.png`)
  }
  await browser.close()
}

/**
 * Phase 2 — does the model know when *not* to draw?
 *
 * One assertion per case, and it is a blunt one: did a ```` ```svg ```` fence
 * appear. Nothing here inspects the figure, because on a "should not draw" case
 * a beautiful figure is still a failure, and on a "should draw" case phase 1 has
 * already measured what the figures look like.
 */
async function restraintPhase() {
  console.log('Phase 2 — restraint')
  console.log(`${RESTRAINT.length} prompts x ${RUNS} runs\n`)

  const tally = []
  for (const spec of RESTRAINT) {
    let drew = 0
    for (let run = 1; run <= RUNS; run++) {
      let text
      try {
        text = await ask(spec.prompt)
      } catch (err) {
        check(`${spec.key} run ${run} answered`, false, err.message)
        continue
      }
      // The fence is the trigger the renderer keys on, so it is the right thing
      // to assert — a bare `<svg>` in prose is stripped by react-markdown and
      // never becomes a figure.
      const fenced = /```[ \t]*svg\b/i.test(text)
      if (fenced) drew++
      check(
        `${spec.key} run ${run} — ${fenced ? 'drew' : 'no figure'}`,
        fenced === spec.draw,
        `expected ${spec.draw ? 'a figure' : 'no figure'}; reply began "${text.slice(0, 70).replace(/\n/g, ' ')}"`,
      )
    }
    tally.push({ key: spec.key, want: spec.draw, drew, runs: RUNS })
  }

  console.log('\n  key                  expected   drew')
  for (const t of tally) {
    console.log(
      `  ${t.key.padEnd(20)} ${(t.want ? 'figure' : 'none').padEnd(10)} ${t.drew}/${t.runs}`,
    )
  }
  console.log()
}

async function main() {
  console.log(`SVG diagram probe — ${MODEL} via ${BASE_URL}`)
  mkdirSync(OUT_DIR, { recursive: true })

  if (PHASE === '2') {
    await restraintPhase()
    return
  }

  console.log(`Phase 1 — quality: ${PROMPTS.length} figures x ${RUNS} runs\n`)
  const candidates = []

  for (const spec of PROMPTS) {
    console.log(`${spec.key}`)
    for (let run = 1; run <= RUNS; run++) {
      const name = `${spec.key}-${run}`
      let text
      try {
        text = await ask(spec.prompt)
      } catch (err) {
        check(`run ${run} answered`, false, err.message)
        results.push({ name, ok: false })
        continue
      }

      const svg = extractSvg(text)
      console.log(`  run ${run} — ${text.length} chars, svg ${svg ? `${svg.length} chars` : 'NOT FOUND'}`)
      if (!check(`run ${run} returned an svg`, svg !== null, text.slice(0, 120))) {
        results.push({ name, ok: false })
        continue
      }

      writeFileSync(resolve(OUT_DIR, `${name}.svg`), svg)

      // Well-formedness, checked the way the browser will check it.
      let parseError = null
      try {
        // A DOMParser is not available in Node; this is the cheap equivalent —
        // balanced tags and a single root are what actually break rendering.
        const opens = (svg.match(/<svg[\s>]/g) ?? []).length
        const closes = (svg.match(/<\/svg>/g) ?? []).length
        if (opens !== 1 || closes !== 1) parseError = `${opens} <svg>, ${closes} </svg>`
      } catch (err) {
        parseError = err.message
      }
      check(`  parses`, parseError === null, parseError ?? '')
      check(`  has viewBox`, /viewBox\s*=/.test(svg))
      // SvgFigure reads this for the caption and the accessible name, so a
      // figure without one is anonymous in the UI and to a screen reader.
      check(`  has <title>`, /<title[\s>]/.test(svg))

      const labels = (svg.match(/<text[\s>]/g) ?? []).length
      check(`  labelled (${labels} text nodes)`, labels >= MIN_LABELS, `need ${MIN_LABELS}`)

      check(`  themeable (currentColor)`, svg.includes('currentColor'))

      const inert =
        !/<script/i.test(svg) &&
        !/\son[a-z]+\s*=/i.test(svg) &&
        !/href\s*=\s*["']https?:/i.test(svg) &&
        !/<image[\s>]/i.test(svg)
      check(`  inert (no script/handlers/external refs)`, inert)

      const missing = spec.checks.filter((c) => !svg.includes(c))
      check(`  contains ${spec.checks.join(', ')}`, missing.length === 0, `missing ${missing.join(', ')}`)

      candidates.push({ name, svg })
      results.push({ name, ok: true, labels, bytes: svg.length })
    }
    console.log()
  }

  if (!NO_RENDER && candidates.length > 0) {
    console.log('Rendering to PNG for visual review')
    try {
      await render(candidates)
    } catch (err) {
      console.log(`  (render skipped: ${err.message})`)
    }
  }

  console.log('\nSummary')
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? ` — ${r.labels} labels, ${r.bytes} bytes` : ''}`)
  }
  console.log()

  if (PHASE !== '1') await restraintPhase()

  console.log(`${passed} passed, ${failed} failed`)
  console.log(
    'Phase 1 is structural only. Whether the figures are CORRECT is a visual call —\n' +
      'open shots/svg-probe/*.png before trusting any of this.',
  )
}

main().catch((err) => {
  console.error(`\nfatal: ${err.message}`)
  process.exit(1)
})
