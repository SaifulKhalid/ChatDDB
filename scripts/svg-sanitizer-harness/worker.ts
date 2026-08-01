/**
 * A one-route Worker that exposes `sanitizeSvg` over HTTP so it can be tested.
 *
 * It exists because the function under test needs `HTMLRewriter`, which lives in
 * workerd and nowhere else — there is no Node shim, and a mock would test the
 * mock. `scripts/smoke-svg-sanitizer.mjs` boots this, fires payloads at it, and
 * tears it down.
 *
 * Note the import: this pulls in the *shipped* module rather than a copy. A test
 * harness that restates the allowlists would keep passing after someone edited
 * the real ones, which is precisely the failure the lowercase-`viewBox` bug
 * would have been.
 *
 * Not part of the deployed Worker. It has its own wrangler config and is never
 * referenced by `worker/index.ts`.
 */

import { sanitizeSvg } from '../../worker/lib/sanitizeSvg.ts'

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('POST an SVG', { status: 405 })
    const source = await request.text()
    const cleaned = await sanitizeSvg(source)
    return new Response(JSON.stringify({ cleaned }), {
      headers: { 'Content-Type': 'application/json' },
    })
  },
}
