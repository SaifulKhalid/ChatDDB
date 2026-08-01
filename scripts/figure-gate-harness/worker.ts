/**
 * A one-route Worker that drives `FigureGate` over HTTP so it can be tested.
 *
 * Separate from `svg-sanitizer-harness` deliberately, even though the two are
 * nearly identical: each smoke test boots its own Worker on its own port and
 * neither can break the other by adding a route.
 *
 * POST a JSON array of strings — the upstream deltas, split exactly where the
 * test wants the chunk boundaries to fall, which is the whole point, since
 * boundary handling is what the gate is for.
 *
 * The reply keeps each `push()` result as its own group rather than one flat
 * list, because *when* something is emitted is half of what needs asserting.
 * The placeholder claim is specifically that the opening fence goes out on the
 * push that first saw it, not later with the body — which is only visible if
 * the groups are kept apart.
 *
 * It exists because the gate awaits `sanitizeSvg`, which needs `HTMLRewriter`,
 * which lives in workerd and nowhere else. As with the sanitiser harness, this
 * imports the *shipped* module rather than a copy.
 *
 * Not part of the deployed Worker.
 */

import { FigureGate } from '../../worker/lib/figureGate.ts'

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('POST a JSON array of chunks', { status: 405 })

    const chunks = (await request.json()) as string[]
    const gate = new FigureGate()
    const pushes: string[][] = []
    for (const chunk of chunks) pushes.push(await gate.push(chunk))
    const flush = await gate.flush()

    const pieces = [...pushes.flat(), ...flush]
    return new Response(JSON.stringify({ pushes, flush, pieces, text: pieces.join('') }), {
      headers: { 'Content-Type': 'application/json' },
    })
  },
}
