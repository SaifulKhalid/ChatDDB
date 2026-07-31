// Smoke-test driver: drives the ChatDDB UI in headless Edge and saves screenshots.
import { chromium } from 'playwright-core'
import fs from 'node:fs'

const OUT = 'shots'
fs.mkdirSync(OUT, { recursive: true })
const errors = []

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text())
})
page.on('pageerror', (err) => errors.push(String(err)))

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' })
await page.waitForSelector('text=How can I help you today?', { timeout: 15000 })
await page.screenshot({ path: `${OUT}/01-welcome-light.png` })

// Toggle dark mode
await page.click('button[aria-label="Switch to dark mode"]')
await page.waitForTimeout(300)
await page.screenshot({ path: `${OUT}/02-welcome-dark.png` })

// Send a message and let the reply finish. Waits on the assistant bubble
// filling in rather than on any specific text, so this passes whether the
// Worker is serving real gpt-5.6-sol output or the UI is on its mock fallback.
await page.fill('textarea[aria-label="Message ChatDDB"]', 'Hello ChatDDB! Show me what you can render.')
await page.press('textarea[aria-label="Message ChatDDB"]', 'Enter')
await page.waitForFunction(
  () => {
    const groups = document.querySelectorAll('[data-role="assistant"]')
    const last = groups[groups.length - 1]
    return !!last && (last.textContent ?? '').trim().length > 20
  },
  null,
  { timeout: 90000 },
)
// Stop button reverting to Send means the stream ended.
await page.waitForSelector('button[aria-label="Send message"]', { timeout: 90000 })
await page.waitForTimeout(800)
await page.screenshot({ path: `${OUT}/03-chat-dark.png` })

// Sidebar should now list the conversation
const sidebarItem = await page.textContent('aside nav')
console.log('SIDEBAR:', sidebarItem?.slice(0, 120))

// Mobile viewport — sidebar should auto-close into overlay mode
await page.setViewportSize({ width: 390, height: 844 })
await page.waitForSelector('button[aria-label="Open sidebar"]', { timeout: 10000 })
await page.screenshot({ path: `${OUT}/04-chat-mobile.png` })

// Open sidebar overlay on mobile
await page.click('button[aria-label="Open sidebar"]')
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/05-sidebar-mobile.png` })

console.log('CONSOLE_ERRORS:', errors.length ? errors.join(' | ') : 'none')
await browser.close()
