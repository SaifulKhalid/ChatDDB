import { chromium } from 'playwright-core'

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' })
await page.waitForSelector('text=How can I help you today?', { timeout: 15000 })

await page.setViewportSize({ width: 390, height: 844 })
await page.waitForSelector('button[aria-label="Open sidebar"]', { timeout: 10000 })
await page.waitForTimeout(600)
await page.screenshot({ path: 'shots/04-chat-mobile.png' })

await page.click('button[aria-label="Open sidebar"]')
await page.waitForTimeout(500)
await page.screenshot({ path: 'shots/05-sidebar-mobile.png' })
await browser.close()
console.log('OK')
