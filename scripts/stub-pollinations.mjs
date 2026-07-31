#!/usr/bin/env node

/**
 * A fake Pollinations endpoint, for testing the image crossover for free.
 *
 * The sibling of `stub-gateway.mjs`, and it exists for a sharper reason than
 * that one does. Pollinations is metered, its allowance is small, and the
 * failure modes worth testing -- an exhausted quota, a withdrawn model, a
 * refused prompt -- are precisely the ones you cannot ask a live provider to
 * reproduce on demand. Point `POLLINATIONS_BASE_URL` here and every branch of
 * `classifyPollinations` becomes reachable from a smoke test.
 *
 * It answers the one route `worker/images.ts` calls:
 *
 *   GET /image/{encodeURIComponent(prompt)}?model=&width=&height=
 *
 * with raw image bytes and `Content-Type: image/jpeg` -- no base64, matching
 * the real thing.
 *
 * Usage:
 *   node scripts/stub-pollinations.mjs                    # serves a 1x1 JPEG
 *   PORT=8798 node scripts/stub-pollinations.mjs
 *   STUB_FORMAT=png node scripts/stub-pollinations.mjs    # exercise the PNG sniff
 *   STUB_FAIL=quota node scripts/stub-pollinations.mjs    # 401, the over-pace shape
 *   STUB_FAIL=model node scripts/stub-pollinations.mjs    # 400, unknown model
 *   STUB_FAIL=refused node scripts/stub-pollinations.mjs  # 400, content policy
 *   STUB_FAIL=down node scripts/stub-pollinations.mjs     # 503
 *   STUB_FAIL=json200 node scripts/stub-pollinations.mjs  # 200 carrying JSON
 *
 * ## Choosing the failure per request
 *
 * `STUB_FAIL` sets the default, but any prompt containing `[stub:MODE]` -- for
 * example `[stub:quota]` -- overrides it for that one request. The prompt is the
 * only field the Worker lets a caller push all the way through to this endpoint,
 * so it is the only channel available, and it turns what would otherwise be five
 * restarts into a single smoke run. `scripts/smoke-image-failover.mjs` drives
 * every branch of `classifyPollinations` this way.
 *
 * Then break Workers AI and point the backup here. A bogus model id is the
 * cheapest way to make the primary fail with something crossable -- the binding
 * answers "No such model", which `classifyWorkersAi` maps to
 * `image_model_unavailable`:
 *
 *   npx wrangler dev --port 8787 \
 *     --var IMAGE_MODEL:@cf/nonexistent/no-such-model \
 *     --var POLLINATIONS_API_KEY:stub-key \
 *     --var POLLINATIONS_BASE_URL:http://127.0.0.1:8798
 *
 * Passing vars on the command line keeps `.dev.vars` untouched, the same
 * convention Phase 2-2 used for the gateway failover.
 *
 * ## The 401 is not a mistake
 *
 * `STUB_FAIL=quota` answers **401 UNAUTHORIZED**, not 429. That is what the real
 * endpoint does when you exceed its pace, and reproducing it faithfully is the
 * entire point -- a stub that returned a tidy 429 would let a Worker that only
 * handles 429 pass a test it should fail. See the note on `classifyPollinations`
 * in `worker/images.ts`.
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8798)
const FAIL = process.env.STUB_FAIL ?? ''
const FORMAT = process.env.STUB_FORMAT === 'png' ? 'png' : 'jpeg'

/** A 1x1 JPEG. Starts FF D8 FF, which is what `sniff()` looks for. */
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
)

/** A 1x1 PNG. Starts 89 50 4E 47 -- the other branch of `sniff()`. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** Error envelopes copied from the live endpoint's actual wording. */
const FAILURES = {
  quota: {
    status: 401,
    body: {
      success: false,
      error: {
        message:
          'Authentication required. Please provide an API key via Authorization header, ' +
          'or reduce your request rate.',
        code: 'UNAUTHORIZED',
      },
      status: 401,
    },
  },
  model: {
    status: 400,
    body: {
      success: false,
      error: {
        message: 'Invalid model or alias: "turbo". Must be a valid model name or alias.',
        code: 'BAD_REQUEST',
      },
      status: 400,
    },
  },
  refused: {
    status: 400,
    body: {
      success: false,
      error: {
        message: 'The requested prompt was rejected: NSFW content is not permitted.',
        code: 'BAD_REQUEST',
      },
      status: 400,
    },
  },
  down: {
    status: 503,
    body: {
      success: false,
      error: { message: 'Upstream image service is temporarily unavailable.', code: 'SERVICE_UNAVAILABLE' },
      status: 503,
    },
  },
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(text)
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  console.log(`[pollinations-stub] ${req.method} ${url.pathname.slice(0, 120)}`)

  if (!url.pathname.startsWith('/image/')) {
    return sendJson(res, 404, {
      success: false,
      error: { message: `no stub route for ${url.pathname}`, code: 'NOT_FOUND' },
      status: 404,
    })
  }

  // The Worker sends the prompt as a path segment, so a prompt that breaks
  // encoding shows up here as a mangled path rather than as a mystery upstream.
  const prompt = decodeURIComponent(url.pathname.slice('/image/'.length))
  const model = url.searchParams.get('model') ?? '-'
  const size = `${url.searchParams.get('width') ?? '-'}x${url.searchParams.get('height') ?? '-'}`
  const auth = req.headers.authorization ? 'bearer' : 'none'
  console.log(`[pollinations-stub]   model=${model} size=${size} auth=${auth}`)
  console.log(`[pollinations-stub]   prompt="${prompt.slice(0, 160)}"`)

  // Not a real check -- the live endpoint treats an unrecognised token as
  // anonymous rather than refusing it. Logged only, so a Worker that forgets the
  // header entirely is still visible here.
  if (!req.headers.authorization) {
    console.log('[pollinations-stub]   note: no Authorization header was sent')
  }

  // `[stub:MODE]` in the prompt beats the environment default -- see the header.
  const marker = /\[stub:([a-z0-9_-]+)\]/i.exec(prompt)
  const mode = marker ? marker[1].toLowerCase() : FAIL
  if (marker) console.log(`[pollinations-stub]   prompt selected mode "${mode}"`)

  if (mode === 'ok') {
    // An explicit "succeed regardless of STUB_FAIL", so a single stub can serve
    // both the crossover-succeeds case and the crossover-fails cases.
    return sendImage(res)
  }

  if (mode === 'json200') {
    // A 200 whose body is an error envelope. The Worker must notice the
    // content-type rather than storing JSON as if it were a picture.
    return sendJson(res, 200, {
      success: false,
      error: { message: 'Generation failed after the status line was sent.', code: 'INTERNAL' },
      status: 200,
    })
  }

  const failure = FAILURES[mode]
  if (failure) return sendJson(res, failure.status, failure.body)

  if (mode) {
    return sendJson(res, 500, {
      success: false,
      error: { message: `unknown stub failure mode "${mode}"`, code: 'INTERNAL' },
      status: 500,
    })
  }

  return sendImage(res)
})

function sendImage(res) {
  const bytes = FORMAT === 'png' ? PNG_1X1 : JPEG_1X1
  res.writeHead(200, {
    'Content-Type': FORMAT === 'png' ? 'image/png' : 'image/jpeg',
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
  })
  res.end(bytes)
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[pollinations-stub] listening on http://127.0.0.1:${PORT} serving 1x1 ${FORMAT.toUpperCase()}`)
  if (FAIL) console.log(`[pollinations-stub] failure mode: ${FAIL}`)
})
