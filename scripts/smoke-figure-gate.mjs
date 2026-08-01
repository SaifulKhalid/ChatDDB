#!/usr/bin/env node

/**
 * Tests `worker/lib/figureGate.ts` against the real workerd runtime.
 *
 * The gate's whole job is to behave correctly at boundaries the happy path
 * never visits, so most of these cases are deliberately awkward: fences split
 * mid-marker, streams that stop halfway through a figure, backticks in ordinary
 * prose. Four properties are load-bearing and each has its own section below.
 *
 *   1. Prose is untouched. A stream with no figure in it must come out
 *      byte-identical, including its backticks — the gate holds a short tail
 *      while it watches for a fence, and a bug there silently eats the last few
 *      characters of every reply.
 *   2. The placeholder is immediate. The opening fence must be emitted on the
 *      same push that recognised it, not saved up with the body; otherwise the
 *      reader gets dead air for the length of the figure, which is the exact
 *      complaint this design exists to avoid.
 *   3. Nothing reaches the client unsanitised. Every route out of the gate --
 *      clean close, truncation, overflow -- passes through `sanitizeSvg` first.
 *   4. Nothing is silently swallowed. A figure that fails or is cut off leaves
 *      a visible note, never an empty gap.
 *
 * Usage:
 *   npm run smoke:figure-gate
 *
 * Boots the harness Worker itself on port 8793 and shuts it down at the end, so
 * it needs no other terminal and no credentials.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const PORT = Number.parseInt(process.env.PORT ?? '8793', 10)
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

/** Runs the chunks through the gate. Returns `{ pushes, flush, pieces, text }`. */
async function run(chunks) {
  const res = await fetch(BASE, { method: 'POST', body: JSON.stringify(chunks) })
  return res.json()
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
      resolve(__dirname, 'figure-gate-harness', 'wrangler.jsonc'),
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
      const res = await fetch(BASE, { method: 'POST', body: '["hi"]' })
      if (res.ok) return true
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

const FIGURE = '<svg viewBox="0 0 100 50" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="4"/></svg>'

async function main() {
  console.log('Figure gate smoke test')
  console.log('  starting harness Worker…')
  const child = startHarness()

  try {
    if (!(await waitForReady())) {
      console.error('  harness did not come up')
      failed++
      return
    }
    console.log(`  harness ready on ${BASE}\n`)

    // ---- 1. Prose passes through untouched --------------------------------
    console.log('Prose is untouched')
    const plain = await run(['Hello, ', 'this is an ordinary reply.'])
    check('plain text round-trips exactly', plain.text === 'Hello, this is an ordinary reply.', plain.text)

    // The tail-holding logic is the risk here: a reply ending on a backtick, or
    // containing inline code, must not lose characters to the fence watcher.
    const ticks = await run(['Call `fetch()` and then ', 'run `npm test`.'])
    check('inline code survives', ticks.text === 'Call `fetch()` and then run `npm test`.', ticks.text)
    const trailing = await run(['ends on a backtick `'])
    check('a reply ending mid-marker still flushes', trailing.text === 'ends on a backtick `', trailing.text)
    const fenceOnly = await run(['```js\nconst x = 1\n```'])
    check('a non-svg fence is not intercepted', fenceOnly.text === '```js\nconst x = 1\n```', fenceOnly.text)

    // ---- 2. The placeholder is emitted immediately -------------------------
    console.log('\nPlaceholder timing')
    const staged = await run(['Here is the plot:\n\n```svg\n', FIGURE.slice(0, 40), FIGURE.slice(40), '\n```\nDone.'])
    check(
      'the opening fence goes out on the push that saw it',
      staged.pushes[0].includes('```svg\n'),
      JSON.stringify(staged.pushes[0]),
    )
    check(
      'the prose before it goes out first',
      staged.pushes[0][0] === 'Here is the plot:\n\n',
      JSON.stringify(staged.pushes[0]),
    )
    check(
      'the figure body is withheld while incomplete',
      staged.pushes[1].length === 0 && staged.pushes[2].length === 0,
      JSON.stringify([staged.pushes[1], staged.pushes[2]]),
    )
    check('the body arrives when the fence closes', staged.pushes[3].some((p) => p.includes('<circle')))
    check('trailing prose resumes after the figure', staged.text.endsWith('Done.'), staged.text)
    check('exactly one opening fence in the output', staged.text.split('```svg').length - 1 === 1, staged.text)

    // ---- 3. Split markers --------------------------------------------------
    console.log('\nSplit fence markers')
    const split = await run(['before ``', '`svg\n', FIGURE, '\n``', '`\nafter'])
    check('an opening fence split mid-marker is recognised', split.text.includes('```svg\n'), split.text)
    check('a closing fence split mid-marker is recognised', split.text.includes('<circle'), split.text)
    check('prose either side survives', split.text.startsWith('before ') && split.text.endsWith('\nafter'), split.text)

    // ---- 4. Sanitisation on every route out --------------------------------
    console.log('\nSanitisation')
    const nasty = await run([
      '```svg\n<svg viewBox="0 0 10 10"><foreignObject><script>alert(1)</script></foreignObject>' +
        '<circle cx="1" cy="1" r="1" onload="steal()"/></svg>\n```',
    ])
    check('script is gone', !nasty.text.includes('alert'), nasty.text)
    check('foreignObject is gone', !/foreignObject/i.test(nasty.text), nasty.text)
    check('onload is gone', !/onload/i.test(nasty.text), nasty.text)
    check('the legitimate circle survives', nasty.text.includes('<circle'), nasty.text)
    check('viewBox survives the round trip', /viewBox="0 0 10 10"/.test(nasty.text), nasty.text)

    // The truncated path is the one most likely to skip the sanitiser, because
    // it is the path written last and exercised least.
    const nastyCut = await run(['```svg\n<svg viewBox="0 0 10 10"><circle cx="1" cy="1" r="1" onclick="x()"/>'])
    check('a truncated figure is sanitised too', !/onclick/i.test(nastyCut.text), nastyCut.text)

    // ---- 5. Truncation: the user's stated gap ------------------------------
    console.log('\nTruncated fence (no closing ``` ever arrives)')
    const cut = await run(['Here:\n\n```svg\n<svg viewBox="0 0 100 50"><circle cx="10" cy="10" r="4"/>'])
    check('the prose before it is not lost', cut.text.startsWith('Here:\n\n'), cut.text)
    check('the partial figure is emitted', cut.text.includes('<circle'), cut.text)
    check('the block is closed', cut.text.includes('\n```\n'), cut.text)
    check('the cut-off is stated visibly', cut.text.includes('cut off'), cut.text)
    check('the salvaged figure has a root', cut.text.includes('<svg'), cut.text)

    const cutEmpty = await run(['```svg\n'])
    check('an empty unterminated fence still closes', cutEmpty.text.includes('```'), cutEmpty.text)
    check('and says something happened', /cut off/.test(cutEmpty.text), cutEmpty.text)

    // ---- 6. Overflow -------------------------------------------------------
    console.log('\nOverflow')
    const huge = `<svg viewBox="0 0 10 10">${'<circle cx="1" cy="1" r="1"/>'.repeat(4000)}`
    const over = await run(['```svg\n', huge, '</svg>\n```\ntail'])
    check(`oversized figure is bounded (input ${huge.length} bytes)`, over.text.length < huge.length, `${over.text.length} bytes out`)
    check('overflow is reported, not swallowed', /cut off/.test(over.text), over.text.slice(0, 200))
    check('the discarded remainder does not leak into the prose', !over.text.includes('<circle cx="1" cy="1" r="1"/></svg>\n```\ntail'))
    check('no stray unmatched fence follows', over.text.split('```svg').length - 1 === 1, over.text.slice(-200))

    // ---- 7. Unusable content is reported, not dropped ----------------------
    console.log('\nUnusable figures')
    const junk = await run(['```svg\nnot markup at all\n```\nrest'])
    check('a non-SVG svg block is reported', /could not be rendered/.test(junk.text), junk.text)
    check('the prose after it survives', junk.text.endsWith('rest'), junk.text)

    // ---- 8. Two figures in one reply ---------------------------------------
    console.log('\nMultiple figures')
    const two = await run([`one\n\n\`\`\`svg\n${FIGURE}\n\`\`\`\n\ntwo\n\n\`\`\`svg\n${FIGURE}\n\`\`\`\n\nthree`])
    check('both figures render', two.text.split('<circle').length - 1 === 2, two.text)
    check('all three prose runs survive', /one[\s\S]*two[\s\S]*three/.test(two.text), two.text)
    check('no note is emitted for clean figures', !/cut off|could not be rendered/.test(two.text), two.text)
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
