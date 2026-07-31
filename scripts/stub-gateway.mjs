#!/usr/bin/env node

/**
 * A fake OpenAI-compatible gateway, for testing failover without spending money.
 *
 * freemodel.dev is metered, and its key may not even exist yet. Point
 * `FREEMODEL_BASE_URL` at this instead and the Worker cannot tell the
 * difference: same `/v1/chat/completions`, same SSE frame shape, same
 * `[DONE]` sentinel, plus the non-streaming form `generateTitle` uses and the
 * `/v1/models` catalogue.
 *
 * Usage:
 *   node scripts/stub-gateway.mjs               # listens on 8799 as "gpt-5.5"
 *   PORT=9001 STUB_MODEL=gpt-5.4 node scripts/stub-gateway.mjs
 *   STUB_FAIL=503 node scripts/stub-gateway.mjs # refuse everything, to test
 *                                               # "both gateways down"
 *
 * Then, in another terminal, break the primary and arm this as the backup:
 *
 *   npx wrangler dev --port 8788 \
 *     --var AGENTROUTER_BASE_URL:http://127.0.0.1:9/v1 \
 *     --var FREEMODEL_API_KEY:stub-key \
 *     --var FREEMODEL_BASE_URL:http://127.0.0.1:8799/v1
 *
 * `127.0.0.1:9` is the discard port — nothing listens, so the primary fails as
 * a network error, which is the branch that should cross over immediately.
 * Passing vars on the command line keeps `.dev.vars` untouched.
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8799)
const MODEL = process.env.STUB_MODEL ?? 'gpt-5.5'
const FAIL = process.env.STUB_FAIL ? Number(process.env.STUB_FAIL) : 0
/** Words the stub "generates". Recognisable in a transcript on sight. */
const REPLY = 'This reply came from the stub gateway, not from AgentRouter.'

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  console.log(`[stub] ${req.method} ${url.pathname}`)

  if (FAIL) {
    return send(res, FAIL, { error: { message: `stub configured to fail with ${FAIL}`, type: 'server_error' } })
  }

  if (url.pathname.endsWith('/models')) {
    return send(res, 200, {
      object: 'list',
      data: [MODEL, 'gpt-5.4', 'gpt-5.4-mini'].map((id) => ({ id, object: 'model', owned_by: 'stub' })),
    })
  }

  if (!url.pathname.endsWith('/chat/completions')) {
    return send(res, 404, { error: { message: `no stub route for ${url.pathname}`, type: 'not_found' } })
  }

  const body = await readBody(req)

  // Reject the shapes a real gateway would, so a body bug shows up here rather
  // than as a mystery in production.
  if (!body.model) {
    return send(res, 400, { error: { message: 'model is required', type: 'invalid_request_error' } })
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return send(res, 400, { error: { message: 'messages is required', type: 'invalid_request_error' } })
  }
  const tokenParam = 'max_completion_tokens' in body ? 'max_completion_tokens' : 'max_tokens' in body ? 'max_tokens' : 'none'
  console.log(
    `[stub]   model=${body.model} stream=${body.stream === true} tokenParam=${tokenParam} ` +
      `reasoning_effort=${body.reasoning_effort ?? '-'} messages=${body.messages.length}`,
  )

  // `generateTitle` asks for `stream: false` and reads `choices[0].message`.
  if (body.stream !== true) {
    return send(res, 200, {
      id: 'stub-title',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Stub gateway smoke test' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    })
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
  const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)

  // One word per frame, so the Worker's SSE parser has real chunk boundaries to
  // handle rather than one convenient blob.
  for (const word of REPLY.split(' ')) {
    frame({
      id: 'stub-1',
      object: 'chat.completion.chunk',
      model: body.model,
      choices: [{ index: 0, delta: { content: `${word} ` }, finish_reason: null }],
    })
    await new Promise((r) => setTimeout(r, 15))
  }
  frame({
    id: 'stub-1',
    object: 'chat.completion.chunk',
    model: body.model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })
  // `stream_options: {include_usage: true}` asks for this; it is what makes
  // `token_source` say `upstream` instead of `estimate`.
  if (body.stream_options?.include_usage) {
    frame({
      id: 'stub-1',
      object: 'chat.completion.chunk',
      model: body.model,
      choices: [],
      usage: { prompt_tokens: 42, completion_tokens: 11, total_tokens: 53 },
    })
  }
  res.write('data: [DONE]\n\n')
  res.end()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[stub] OpenAI-compatible gateway on http://127.0.0.1:${PORT}/v1 as "${MODEL}"`)
  if (FAIL) console.log(`[stub] refusing every request with HTTP ${FAIL}`)
})
