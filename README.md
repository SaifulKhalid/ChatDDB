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
- Technical figures drawn as SVG: a ` ```svg ` block renders as a themed figure with a caption, a Source toggle and a download, instead of printing as code
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
| `worker/failover.ts` | The gateway chain: AgentRouter, then freemodel.dev |
| `worker/images.ts` | The image chain: Workers AI, then Pollinations |
| `worker/sse.ts` | Normalises upstream SSE to the contract above; peeks for tool calls; gates SVG figures |
| `worker/lib/figureGate.ts` | Withholds a ` ```svg ` block until it is complete and sanitised |
| `worker/lib/sanitizeSvg.ts` | HTMLRewriter allowlist — the server-side half of the SVG defence |

Config lives in `wrangler.jsonc` `vars` (model, base URL, token cap, timeout) and can be overridden per-machine in `.dev.vars`. Full reference in [DOCS.md § 4](DOCS.md#4-configuration).

### Two failover chains, both silent

Each of the two things this app asks an outside provider for has a backup behind it, and neither announces itself. There is no picker, no provider badge, and nothing in `src/` knows which one answered.

**Text: AgentRouter → freemodel.dev.** AgentRouter fails often enough that users noticed. `completeWithFailover` in `worker/failover.ts` sits *above* the stream opener, so it cannot restart a stream that has already delivered bytes — a mid-flight death still surfaces as an SSE error frame. A crossover writes an `upstream_failover` activity row and sets `X-ChatDDB-Upstream`.

**Images: Workers AI → Pollinations.** The Cloudflare free allowance is 10,000 neurons *per account per day*, shared by every signed-in user, so the first person to spend it used to take image generation down for everyone until 00:00 UTC. `generateImage` in `worker/images.ts` crosses over on exactly two error classes — `image_quota_exhausted` and `image_model_unavailable`, the two that mean *this provider cannot serve right now*. A refusal is deliberately **not** one of them: resubmitting a prompt one safety filter rejected to a provider with a different policy would make the deployment's effective content policy "whichever provider is last on the chain". Crossovers write an `image_failover` row, and `files.gen_model` records what actually drew the image (`pollinations/flux`, not the Cloudflare model id).

Both backups are metered, so both are backups rather than peers: a missing primary is an error, not a reason to run entirely on the paid one. `FALLBACK_ENABLED` and `POLLINATIONS_ENABLED` switch them off, and only the exact string `"false"` does — a typo leaves the backup armed rather than silently removing it.

### Generating images mid-conversation

The model can attach one image to a reply by calling a `generate_image` tool, so "can you show me one?" works without the user reaching for the composer's image toggle. The toggle and `POST /api/images` are unchanged; this is an additional path.

The tool is offered on the first upstream request, and `peekToolCalls` in `worker/sse.ts` reads far enough into the response to tell a tool call from ordinary text before any byte reaches the client — a stream that turns out to be text is replayed intact, so the ordinary path loses nothing. Execution runs server-side through the same image chain, the same `limitImage` gate, and the same R2 write as the button, then the result goes back upstream for a final answer.

`RATE_TOOL_IMAGE_PER_DAY` (default 5) caps it *on top of* the ordinary image budget, because the guidance about when to fire is a sentence in a prompt and a sentence in a prompt has never been a spending control. Probe measurements behind the design are in `scripts/probe-tool-calling.mjs`.

### Diagrams are drawn, not generated

Most of this app's users are engineering students, and most of what they ask to see is a pole-zero plot, a Bode sketch, a free-body diagram or a circuit — figures where the *coordinates carry the meaning*. A diffusion model has no symbolic model of an axis, so it produces something that looks like a plot and is wrong in every position that matters. Rated 2/10 by the user who reported it, and no provider swap fixes it, because the failure is the technique rather than the vendor.

So the model draws these instead of generating them: it writes SVG into a ` ```svg ` fence and the browser renders it. Coordinates come from the same reasoning that writes the prose, which is the part that was already right.

**This is not a tool.** Unlike `generate_image` there is nothing to execute server-side — the figure *is* the reply text. That means no second round trip, no rate limiter, no R2 write, no `files` row, and it streams like any other answer. Routing between the two paths is a prompt clause: SVG when position means something, `generate_image` for photographic or artistic imagery. The composer's image toggle is unchanged.

**Two sanitisers, deliberately not shared.** `worker/lib/sanitizeSvg.ts` runs first, in the Worker, using `HTMLRewriter` — a real parser, not a regex — against a strict element/attribute allowlist, so nothing unsanitised is ever persisted or sent. `src/components/SvgFigure.tsx` then re-sanitises with DOMPurify before touching the DOM. The client pass is defence in depth, not the primary control, and it is a *different implementation* on purpose: a shared allowlist would mean one bug defeats both layers.

Between them sits the **figure gate** (`worker/lib/figureGate.ts`): a fenced SVG block is withheld from the stream until it is complete and clean, because half an `<svg>` is not markup that can be judged safe. The moment the opening fence is seen the gate emits the bare fence, so the reader gets a drawing skeleton instead of dead air. The buffer is bounded by size and by a 30-second deadline — a figure that hits `max_tokens` or an upstream drop is closed, sanitised, and captioned *"this figure was cut off"* rather than buffered forever or silently swallowed.

`SVG_DIAGRAMS=false` stops the prompt inviting figures. It does **not** disable the gate or either sanitiser: a user can ask for SVG whatever the prompt says, and "no unsanitised markup reaches a browser" has no useful off position. There is no metered budget behind the switch — drawing costs the output tokens of the reply and nothing more.

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

It also calls tools reliably, which is what the `generate_image` path depends on. `npm run probe:tools` measured 10/10 on prompts that should fire it, 5/5 restraint on one that should not, 5/5 on relaying a tool result, 5/5 on explaining a failed one, and 5/5 producing usable `tool_calls` over a *streaming* request — the last of which is why the decision leg keeps `stream: true` instead of being downgraded to a buffered request. Arguments arrive as ~150 delta fragments, so anything reading them has to reassemble by `index` rather than expecting one frame.

freemodel's tool support has never been probed. The backup is offered `tools` anyway and ignoring the field is survivable by construction: no `tool_calls` just means the turn is answered as plain text, which is what it would have been.

It writes usable SVG, and — the part that actually needed measuring — it knows when not to. `npm run probe:svg` runs two phases. Phase 1 asked for five figures twice each: 10/10 came back as parseable SVG with a `viewBox`, a `<title>`, text labels, `currentColor` fills, and no script, handler or external reference; label counts ran 5–21 and sizes 1.3–3.8 kB. Phase 2 is restraint, three prompts that deserve a figure against four adversarially chosen ones that do not (a derivation, a TCP-vs-UDP comparison, a request for linked-list code, plain prose): 6/6 drew, 8/8 stayed quiet. Structural checks cannot tell you whether an axis is in the right place, so the probe also renders every figure to `shots/svg-probe/*.png` for a human to look at.

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

npm run smoke:svg-sanitizer  # HTMLRewriter allowlist, incl. mXSS + case-mangling cases
npm run smoke:figure-gate    # the streaming fence transform: placeholder timing, truncation, overflow
npm run probe:svg            # real model: can it draw, and does it know when not to
```

Both SVG smoke tests run the *shipped* modules inside a throwaway one-route
Worker (`scripts/*-harness/`), because `HTMLRewriter` only exists in workerd —
testing a Node re-implementation would test the wrong parser. Neither needs a
key. `PHASE=1` / `PHASE=2` and `RUNS=n` narrow the probe, which does spend
tokens.

The UI smoke tests key off the assistant bubble filling in rather than any fixed
text, so they pass whether the Worker is live or the UI is on its mock fallback.
`smoke-backend.mjs` is the exception: it fails if the key is missing, since a
mock reply would make a broken backend look healthy.

