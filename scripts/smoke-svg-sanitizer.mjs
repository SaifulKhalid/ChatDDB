#!/usr/bin/env node

/**
 * Tests `worker/lib/sanitizeSvg.ts` against the real workerd runtime.
 *
 * Every case here is a bug that was either found or narrowly avoided while
 * building the sanitiser, which is why the assertions are so specific about
 * *casing* and about *attributes* rather than only about elements:
 *
 *   - `viewBox` survives. HTMLRewriter reports attribute names pre-lowercased,
 *     so an allowlist spelled `'viewBox'` matches nothing and strips it from
 *     every figure. The diagram then loses its coordinate system and collapses,
 *     with no error anywhere. This is the headline regression test.
 *   - `<linearGradient>` survives, for the same reason one layer up: `tagName`
 *     lowercases to `lineargradient`.
 *   - `clip-path` survives. Allowing `<clipPath>` without the attribute that
 *     references it leaves an inert definition and an unshaded figure — a
 *     silent failure rather than a loud one.
 *   - `<foreignObject><script>` vanishes *with its contents*. A stripper that
 *     removes the wrapper but keeps the children unwraps live script into the
 *     output; `element.remove()` takes the subtree.
 *
 * Usage:
 *   npm run smoke:svg-sanitizer
 *
 * Boots the harness Worker itself on port 8792 and shuts it down at the end, so
 * it needs no other terminal and no credentials.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const PORT = Number.parseInt(process.env.PORT ?? '8792', 10)
const BASE = `http://127.0.0.1:${PORT}`

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

async function clean(svg) {
  const res = await fetch(BASE, { method: 'POST', body: svg })
  const { cleaned } = await res.json()
  return cleaned
}

/**
 * Spawns wrangler the same way the D1 helpers do — `node` on the literal script
 * path. Node 22 on Windows refuses to spawn a `.cmd` shim via execFile, and
 * `shell: true` re-splits arguments on spaces.
 */
function startHarness() {
  const child = spawn(
    process.execPath,
    [
      resolve(ROOT, 'node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '-c',
      resolve(__dirname, 'svg-sanitizer-harness', 'wrangler.jsonc'),
      '--port',
      String(PORT),
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  return child
}

async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE, { method: 'POST', body: '<svg viewBox="0 0 1 1"></svg>' })
      if (res.ok) return true
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

async function main() {
  console.log('SVG sanitizer smoke test')
  console.log('  starting harness Worker…')
  const child = startHarness()

  try {
    if (!(await waitForReady())) {
      console.error('  harness did not come up')
      failed++
      return
    }
    console.log(`  harness ready on ${BASE}\n`)

    // ---- Casing: the regressions that motivated the whole design -----------
    console.log('Casing')
    const viewBox = await clean('<svg viewBox="0 0 100 50" xmlns="http://www.w3.org/2000/svg"></svg>')
    check('viewBox survives with original casing', /viewBox\s*=\s*"0 0 100 50"/.test(viewBox), viewBox)
    check('xmlns survives', viewBox.includes('xmlns='), viewBox)

    const grad = await clean(
      '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/>' +
        '</linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>',
    )
    check('linearGradient survives', /linearGradient/i.test(grad), grad)
    check('stop and stop-color survive', grad.includes('stop-color'), grad)
    check('id survives so url(#g) resolves', grad.includes('id="g"'), grad)

    // ---- Reference attributes, not just reference elements -----------------
    console.log('\nReference attributes')
    const clip = await clean(
      '<svg viewBox="0 0 10 10"><defs><clipPath id="c"><rect width="5" height="5"/></clipPath></defs>' +
        '<circle cx="5" cy="5" r="4" clip-path="url(#c)"/></svg>',
    )
    check('clipPath element survives', /clipPath/i.test(clip), clip)
    check('clip-path attribute survives', clip.includes('clip-path="url(#c)"'), clip)

    const marker = await clean(
      '<svg viewBox="0 0 10 10"><defs><marker id="a" markerWidth="4" refX="2" orient="auto">' +
        '<path d="M0 0"/></marker></defs><line x1="0" y1="0" x2="9" y2="0" marker-end="url(#a)"/></svg>',
    )
    check('marker-end attribute survives', marker.includes('marker-end="url(#a)"'), marker)
    check('markerWidth keeps its casing', /markerWidth/.test(marker), marker)

    // ---- The security cases ------------------------------------------------
    console.log('\nRemoved')
    const nasty = await clean(
      '<svg viewBox="0 0 10 10"><foreignObject><script>alert(1)</script></foreignObject>' +
        '<circle cx="1" cy="1" r="1" onload="steal()"/></svg>',
    )
    check('script contents are gone, not unwrapped', !nasty.includes('alert'), nasty)
    check('foreignObject is gone', !/foreignObject/i.test(nasty), nasty)
    check('onload is gone', !/onload/i.test(nasty), nasty)
    check('the legitimate circle survives', nasty.includes('<circle'), nasty)

    const refs = await clean(
      '<svg viewBox="0 0 10 10"><image href="https://evil.test/p.png" width="1" height="1"/>' +
        '<use href="#x"/><a href="javascript:alert(1)"><text>hi</text></a>' +
        '<style>@import url(https://evil.test/x.css)</style></svg>',
    )
    check('external image is gone', !/<image/i.test(refs), refs)
    check('use is gone', !/<use/i.test(refs), refs)
    check('style block is gone', !/evil\.test/.test(refs), refs)
    check('no href of any kind remains', !/href/i.test(refs), refs)

    const textPath = await clean(
      '<svg viewBox="0 0 10 10"><text><textPath href="#p">curved</textPath></text></svg>',
    )
    check('textPath is dropped (needs href we refuse)', !/textPath/i.test(textPath), textPath)

    const animated = await clean(
      '<svg viewBox="0 0 10 10"><circle cx="1" cy="1" r="1">' +
        '<animate attributeName="r" to="9"/></circle></svg>',
    )
    check('animate is gone', !/<animate/i.test(animated), animated)

    // ---- Rejection, which must be null rather than empty -------------------
    console.log('\nRejected outright')
    check('non-SVG input returns null', (await clean('<div>hello</div>')) === null)
    check('plain text returns null', (await clean('not markup at all')) === null)
    const huge = `<svg viewBox="0 0 10 10">${'<circle cx="1" cy="1" r="1"/>'.repeat(3000)}</svg>`
    check(`oversized input returns null (${huge.length} bytes)`, (await clean(huge)) === null)
  } finally {
    child.kill()
  }
}

main()
  .catch((err) => {
    console.error(`\nfatal: ${err.message}`)
    failed++
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
  })
