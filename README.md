# ChatDDB

A ChatGPT-style AI chatbot. React frontend + a Cloudflare Worker backend that streams **`gpt-5.6-sol`** through **AgentRouter**. **Cloudflare D1** (chat history) and **R2** (file storage) to follow.

📘 **[DOCS.md](DOCS.md)** — full technical documentation: architecture, API reference, configuration, streaming internals, error handling, deployment, troubleshooting.

## Naming (important)

The Cloudflare account already has a `chatddb` Pages project and a `chatddb` D1 database from an earlier prototype. **This project uses the `chatddb-f5` prefix everywhere** to avoid conflicts:

| Resource | Name |
| --- | --- |
| Pages/Workers project | `chatddb-f5` |
| D1 database (planned) | `chatddb-f5-db` |
| R2 bucket (planned) | `chatddb-f5-storage` |

## Status

- ✅ **Frontend** — ChatGPT-clone UI
- ✅ **Backend** — Cloudflare Worker at `/api/chat` streaming `gpt-5.6-sol` via AgentRouter
- 🔜 **Persistence** — D1 for conversations/messages, R2 for attachments

## Setup

The AgentRouter key is a Worker secret and must never reach frontend code.

```bash
npm install
cp .dev.vars.example .dev.vars   # then paste your key into .dev.vars (gitignored)
npm run dev:all                  # vite on :5173 + wrangler on :8787
```

Get a key at <https://agentrouter.org/console/token>. For the deployed Worker:

```bash
npm run secret        # wrangler secret put AGENTROUTER_API_KEY
npm run deploy        # build + wrangler deploy
```

Check wiring at any time with `curl http://localhost:5173/api/health` — `"configured": true` means the key is loaded.

## Frontend features

- Streaming responses with blinking cursor, Stop / Regenerate
- Markdown rendering (GFM tables, lists) with syntax-highlighted code blocks in a framed header carrying the language name and a copy button
- Edit an earlier user message to re-ask it — later turns are dropped and the answer regenerates from that point (as in ChatGPT)
- Copy buttons on every message and code block
- Conversation history: create, rename, delete, search, grouped by date (Today / Yesterday / …), persisted to `localStorage` until D1 lands
- Dark / light theme (system default, toggle, no flash on load)
- Responsive: overlay sidebar + hamburger on mobile, ChatGPT-style layout on desktop
- Mock streaming fallback: if the Worker is unreachable or has no key (404/502/503), the UI streams a demo reply so it stays testable standalone

## Backend

`worker/` holds the Worker. It also serves the built SPA from `dist/`, so one `wrangler deploy` ships the whole app.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/chat` | Stream a completion. Body: `{ "messages": [{ "role", "content" }] }` |
| `POST /api/images` | Generate an image from a prompt. Body: `{ "prompt", "sessionId"? }`. JSON, not SSE |
| `GET /api/health` | Config check — reports the model and whether the key is loaded |
| `GET /api/models` | Model list the key can reach, for debugging |

`/api/chat` responds with `text/event-stream`:

```
data: {"choices":[{"delta":{"content":"Hello"}}]}
data: {"error":{"message":"...","type":"..."}}
data: [DONE]
```

| File | Role |
| --- | --- |
| `worker/index.ts` | Routing, request validation, system prompt, error mapping |
| `worker/agentrouter.ts` | AgentRouter HTTP client — headers, retries, timeout, abort |
| `worker/sse.ts` | Normalises upstream SSE to the contract above |

Config lives in `wrangler.jsonc` `vars` (model, base URL, token cap, timeout) and can be overridden per-machine in `.dev.vars`. Full reference in [DOCS.md § 4](DOCS.md#4-configuration).

### Two AgentRouter quirks worth knowing

**1. It enforces a client whitelist.** A request with an ordinary `User-Agent` is rejected at the edge before it reaches the router:

```json
{"error":{"message":"unauthorized client detected, ..."},"type":"unauthorized_client_error"}
```

The same request with a `claude-cli/<version> (external, ...)` User-Agent is accepted — a bad key then fails with `new_api_error` instead, which is how you tell the two apart. So `AGENTROUTER_USER_AGENT` is mandatory, not cosmetic; it is a `var` so it can be changed without a code edit if the accepted pattern moves.

**2. It does not really stream.** AgentRouter waits for the full completion upstream, then synthesises a single-frame SSE response (the chunk arrives as `"id":"chatcmpl_temp"` carrying the whole answer). The Worker relays that faithfully and adds no delay; the progressive typing effect is produced client-side by `paced()` in `src/lib/api.ts`, which reveals a buffered delta over ~700 ms. Short deltas pass through untouched, so if AgentRouter ever starts real streaming the pacing stops applying on its own.

Pacing was tried in the Worker first and removed: Workers pin `Date.now()` between I/O, so a paced loop cannot measure its own drift and overshot its budget by 2–4×, while billing the sleep as wall-clock time.

### Notes on the model

`gpt-5.6-sol` is a reasoning model, so the Worker sends `max_completion_tokens` (not `max_tokens`) and no `temperature`. Set `REASONING_EFFORT` to trade latency for depth. Reasoning deltas are dropped — the UI has nowhere to show them.

## Development

```bash
npm run dev:all      # vite (:5173) + worker (:8787) together — use this
npm run dev          # frontend only; /api proxies to :8787
npm run dev:worker   # worker only
npm run build        # typecheck (app + worker) + production build to dist/
npm run lint         # oxlint
npm run cf-typegen   # regenerate worker-configuration.d.ts after editing wrangler.jsonc
npm run deploy       # build + deploy to Cloudflare

node smoke.mjs         # headless-Edge UI smoke test (needs dev server; screenshots in shots/)
node smoke-backend.mjs # real gpt-5.6-sol reply, asserts it renders progressively
node smoke-edit.mjs    # message-edit flow: rewrite, drop later turns, regenerate
node smoke-mobile.mjs  # mobile viewport / overlay sidebar
```

The UI smoke tests key off the assistant bubble filling in rather than any fixed
text, so they pass whether the Worker is live or the UI is on its mock fallback.
`smoke-backend.mjs` is the exception: it fails if the key is missing, since a
mock reply would make a broken backend look healthy.

