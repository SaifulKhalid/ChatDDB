// Smoke-test driver for the message-edit flow: editing an earlier user message
// must rewrite it, drop the messages after it, and regenerate from that point.
import { chromium } from 'playwright-core'
import fs from 'node:fs'

const OUT = 'shots'
fs.mkdirSync(OUT, { recursive: true })
const errors = []

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('console', (msg) => {
  // /api/chat 502s on purpose while no Worker is running (mock-stream fallback)
  if (msg.type() === 'error' && !msg.text().includes('502')) errors.push(msg.text())
})
page.on('pageerror', (err) => errors.push(String(err)))

const composer = 'textarea[aria-label="Message ChatDDB"]'

/**
 * Waits for the current reply to finish. Keys off the assistant bubble
 * filling in and the Stop button reverting to Send, so it works against the
 * real Worker and against the UI's mock fallback alike.
 */
const awaitReply = async () => {
  await page.waitForFunction(
    () => {
      const groups = document.querySelectorAll('[data-role="assistant"]')
      const last = groups[groups.length - 1]
      return !!last && (last.textContent ?? '').trim().length > 20
    },
    null,
    { timeout: 90000 },
  )
  await page.waitForSelector('button[aria-label="Send message"]', { timeout: 90000 })
}

const send = async (text) => {
  await page.fill(composer, text)
  await page.press(composer, 'Enter')
  await awaitReply()
}

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' })
await page.waitForSelector('text=How can I help you today?', { timeout: 15000 })

// Two turns, so there is history after the message we edit
await send('First question about indexes')
await send('Second question about joins')

const bubbles = () => page.locator('div.whitespace-pre-wrap')
console.log('USER_MSGS_BEFORE:', await bubbles().count(), '(expect 2)')

// Hover the first user message to reveal its action row, then click Edit
const first = bubbles().first()
await first.hover()
await page.click('button[aria-label="Edit message"]')
await page.waitForSelector('textarea[aria-label="Edit message"]', { timeout: 5000 })
await page.screenshot({ path: `${OUT}/06-edit-open.png` })

// Rewrite and submit
await page.fill('textarea[aria-label="Edit message"]', 'Edited first question about B-trees')
await page.click('button:has-text("Send")')
await awaitReply()
await page.waitForTimeout(500)

const count = await bubbles().count()
const text = await bubbles().first().textContent()
console.log('USER_MSGS_AFTER:', count, '(expect 1 — later turns dropped)')
console.log('FIRST_MSG:', JSON.stringify(text))
console.log('SIDEBAR_TITLE:', (await page.textContent('aside nav'))?.slice(0, 80))
await page.screenshot({ path: `${OUT}/07-edit-regenerated.png` })

const ok =
  count === 1 &&
  text?.includes('B-trees') &&
  !(await page.locator('text=Second question about joins').count())
console.log('EDIT_FLOW:', ok ? 'PASS' : 'FAIL')
console.log('CONSOLE_ERRORS:', errors.length ? errors.join(' | ') : 'none')
await browser.close()
process.exit(ok && !errors.length ? 0 : 1)
