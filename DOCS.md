# ChatDDB — Technical Documentation

ChatDDB is a ChatGPT-style chat application. A React SPA talks to a Cloudflare
Worker, which streams completions from **`gpt-5.6-sol`** through the
**AgentRouter** gateway. Both halves ship as a single Worker deployment.

- [1. Architecture](#1-architecture)
- [2. Getting started](#2-getting-started)
- [3. Project layout](#3-project-layout)
- [4. Configuration](#4-configuration)
- [5. HTTP API](#5-http-api)
- [6. The streaming pipeline](#6-the-streaming-pipeline)
- [7. AgentRouter integration](#7-agentrouter-integration)
- [8. Frontend architecture](#8-frontend-architecture)
- [9. Error handling](#9-error-handling)
- [10. Testing](#10-testing)
- [11. Deployment](#11-deployment)
- [12. Troubleshooting](#12-troubleshooting)
- [13. Roadmap](#13-roadmap)
- [Appendix A — naming constraints](#appendix-a--naming-constraints)
- [Appendix B — known loose ends](#appendix-b--known-loose-ends)

---

## 1. Architecture

```
┌─────────────────────────────────────────┐
│ Browser — React 19 SPA                  │
│   App.tsx        conversation state     │
│   lib/api.ts     SSE reader + pacing    │
│   lib/storage.ts localStorage           │
└───────────────┬─────────────────────────┘
                │  POST /api/chat  (same origin)
                ▼
┌─────────────────────────────────────────┐
│ Cloudflare Worker  "chatddb-f5"         │
│   worker/index.ts        routes, guards │
│   worker/agentrouter.ts  upstream call  │
│   worker/sse.ts          SSE normaliser │
│   assets: dist/  (SPA, same deploy)     │
└───────────────┬─────────────────────────┘
                │  POST /v1/chat/completions
                ▼
      AgentRouter  →  gpt-5.6-sol
```

One Worker serves both the API and the built SPA. `wrangler.jsonc` sets
`run_worker_first: ["/api/*"]`, so asset routing handles real files and
everything under `/api/` reaches the Worker regardless of what is in `dist/`.
Unmatched paths fall back to `index.html` (`not_found_handling:
"single-page-application"`), which is what makes client-side routing work.

### Request lifecycle

1. The user submits a message. `App.tsx` appends it plus an empty `streaming`
   assistant message, then calls `streamChat(history, signal)`.
2. `streamChat` POSTs the whole message history to `/api/chat`. In dev, Vite
   proxies `/api` to `http://localhost:8787`.
3. The Worker resolves config, validates the body, prepends a system prompt,
   and opens an upstream streaming completion.
4. As upstream bytes arrive, `toClientStream` re-emits them as normalised SSE
   frames.
5. `streamChat` parses each frame and yields text; `paced()` spreads oversized
   deltas over ~700 ms so the reply types out instead of appearing at once.
6. Each yielded chunk is appended to the assistant message. `data: [DONE]`
   ends the generator, and the message's `streaming` flag clears.

The client's `AbortController` is wired end to end: pressing **Stop** aborts the
`fetch`, which aborts the Worker's `request.signal`, which aborts the upstream
request — so a cancelled generation stops being billed.

---

## 2. Getting started

Requirements: Node 20+, npm, and a Cloudflare account for deploys (`wrangler
login`). Smoke tests additionally need Microsoft Edge installed.

```bash
npm install
cp .dev.vars.example .dev.vars   # paste your AgentRouter key into .dev.vars
npm run dev:all                  # vite :5173 + wrangler :8787
```

Open <http://localhost:5173>. Get a key at
<https://agentrouter.org/console/token>.

Verify the key is loaded:

```bash
curl http://localhost:5173/api/health
# {"ok":true,"service":"chatddb-f5","model":"gpt-5.6-sol","provider":"agentrouter","configured":true}
```

`"configured": false` means the Worker has no usable key, and the UI will stream
a mock reply rather than fail. `.dev.vars` is gitignored and must never be
committed.

### Scripts

| Script | What it does |
| --- | --- |
| `npm run dev:all` | Vite (`:5173`) and `wrangler dev` (`:8787`) together — the normal way to develop |
| `npm run dev` | Frontend only; `/api` proxies to `:8787` (mock fallback if nothing is there) |
| `npm run dev:worker` | Worker only |
| `npm run build` | `tsc -b` (app + node + worker projects) then `vite build` into `dist/` |
| `npm run preview` | Build, then serve the built SPA *and* the Worker from `:8787` — closest thing to production |
| `npm run lint` | oxlint |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` — rerun after editing `wrangler.jsonc` |
| `npm run secret` | `wrangler secret put AGENTROUTER_API_KEY` for the deployed Worker |
| `npm run secret:pollinations` | Same, for the backup image provider's key |
| `npm run probe:tools` | Measures whether the model actually calls tools, over 5 runs per case — see §10 |
| `npm run probe:svg` | Measures whether the model draws usable figures *and* knows when not to — see §10 |
| `npm run smoke:svg-sanitizer` | The HTMLRewriter allowlist, in workerd. No key needed |
| `npm run smoke:figure-gate` | The streaming fence transform. No key needed |
| `npm run stub:pollinations` | Fake Pollinations endpoint, so crossover tests spend no allowance |
| `npm run smoke:image-failover` | End-to-end image crossover, both directions |
| `npm run smoke:chat-image-tool` | End-to-end `generate_image` tool path |
| `npm run deploy` | Build, then `wrangler deploy` |

---

## 3. Project layout

```
worker/
  index.ts          routes, validation, system prompt, error mapping
  agentrouter.ts    upstream client: config, headers, retries, timeout, abort
  failover.ts       gateway chain: AgentRouter → freemodel.dev
  images.ts         image chain: Workers AI → Pollinations, and error classification
  sse.ts            upstream stream → client SSE contract; tool-call peek; figure gate
  lib/figureGate.ts holds back a ```svg fence until it is whole and clean
  lib/sanitizeSvg.ts HTMLRewriter allowlist — server-side SVG sanitiser
  tsconfig.json     workers-only TS project (ES2023 libs, no DOM)
src/
  App.tsx           all conversation state and turn orchestration
  types.ts          Message, Conversation, newId()
  lib/api.ts        streamChat(), paced(), mock fallback
  lib/storage.ts    localStorage persistence for chats + theme
  components/
    Sidebar.tsx     history list: search, rename, delete, date grouping
    ChatArea.tsx    scroll container, welcome screen, scroll-to-bottom
    MessageItem.tsx user + assistant bubbles, markdown, edit, regenerate
    Composer.tsx    auto-growing textarea, Send/Stop
    CodeBlock.tsx   framed code block with language label + copy
    SvgFigure.tsx   renders a ```svg block as a figure (DOMPurify, id namespacing)
    CopyButton.tsx  copy-to-clipboard with copied state
    Logo.tsx        assistant avatar / brand mark
  index.css         Tailwind v4 theme tokens, markdown + cursor styles
wrangler.jsonc      Worker config: name, assets, vars, planned bindings
vite.config.ts      React + Tailwind plugins, /api dev proxy → :8787
.dev.vars.example   template for the local secret file
smoke*.mjs          Playwright smoke tests (see §10)
```

Three TypeScript projects sit under the root `tsconfig.json` as references:
`tsconfig.app.json` (browser), `tsconfig.node.json` (build tooling), and
`worker/tsconfig.json` (Workers runtime). `npm run build` typechecks all three.

The worker project sets `erasableSyntaxOnly`, so TypeScript constructor
parameter properties are unavailable there — class fields must be declared and
assigned explicitly (see `UpstreamError`).

---

## 4. Configuration

Non-secret settings are `vars` in `wrangler.jsonc`; every one can be overridden
per-machine in `.dev.vars`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTROUTER_API_KEY` | — | **Secret.** Required. `.dev.vars` locally, `wrangler secret put` in production |
| `AGENTROUTER_MODEL` | `gpt-5.6-sol` | Model requested upstream |
| `AGENTROUTER_BASE_URL` | `https://agentrouter.org/v1` | Gateway base; trailing slashes trimmed |
| `AGENTROUTER_USER_AGENT` | `claude-cli/2.1.158 (external, sdk-cli)` | **Mandatory** — see §7 |
| `MAX_OUTPUT_TOKENS` | `8192` | Sent as `max_completion_tokens`; `0` omits the cap |
| `UPSTREAM_TIMEOUT_MS` | `180000` | Time-to-first-byte budget only; never caps an in-flight stream |
| `REASONING_EFFORT` | unset | `minimal` \| `low` \| `medium` \| `high` — omitted when unset |
| `SYSTEM_PROMPT` | built-in | Replaces the default system prompt |
| `POLLINATIONS_API_KEY` | — | **Secret.** Arms the backup image provider. `npm run secret:pollinations` |
| `POLLINATIONS_ENABLED` | armed | Kill switch; only the exact string `"false"` disables |
| `POLLINATIONS_MODEL` | `flux` | Backup image model. `turbo` was retired |
| `POLLINATIONS_BASE_URL` | `https://gen.pollinations.ai` | Backup base; trailing slashes trimmed |
| `RATE_TOOL_IMAGE_PER_DAY` | `5` | Images the *model* may request per user per day, on top of `RATE_IMAGE_PER_DAY` |
| `SVG_DIAGRAMS` | armed | `"false"` stops the prompt inviting figures. Does **not** disable the gate or the sanitisers — see §6 |

The literal placeholder `sk-replace-me` counts as "not configured", so copying
`.dev.vars.example` without editing it behaves the same as having no key.
`pk-replace-me` does the same for Pollinations.

`POLLINATIONS_API_KEY` is a **secret and never a var**: Pollinations meters by
account, so a key in `wrangler.jsonc` would be a spendable credential committed
to git history. Same rule as `FREEMODEL_API_KEY`.

### Request guardrails

`LIMITS` in `worker/index.ts` bounds what one request can cost:

| Limit | Value |
| --- | --- |
| `maxMessages` | 200 |
| `maxCharsPerMessage` | 200,000 |
| `maxTotalChars` | 500,000 |
| `maxBodyBytes` | 2,000,000 (checked against `Content-Length`) |

Breaching any of them returns `400` with a message naming the offending index.

### Default system prompt

> You are ChatDDB, a helpful, knowledgeable AI assistant. Answer accurately and
> get to the point; expand only when the question needs it. Use Markdown —
> fenced code blocks with a language tag, tables where they help. If you are
> unsure or lack the information, say so rather than guessing.

It is prepended only when the posted messages contain no `system` role, so a
client can supply its own.

**`SYSTEM_PROMPT` does not switch off the tool guidance.** The base prompt is
either/or — a custom `SYSTEM_PROMPT` replaces the default outright — but when the
image tool is armed, `TOOL_USE_CLAUSE` is appended *after* whichever base
resolved. The alternative was letting any deployment with a custom prompt hand
the model a working image generator with no instruction about when to use it, and
the budget behind that generator is shared by every user of the deployment and
resets once a day. So the clause cannot be dropped by accident. It is guidance
regardless; `RATE_TOOL_IMAGE_PER_DAY` is the enforcement.

`buildUpstreamMessages` composes the system message from up to four clauses in
order: the base prompt, `TOOL_USE_CLAUSE` if tools are armed, `DIAGRAM_CLAUSE` if
`SVG_DIAGRAMS` is not `"false"`, and `VISUAL_ROUTING_CLAUSE` only when **both**
are on — there is nothing to route between otherwise. `DIAGRAM_CLAUSE` leads with
restraint (*when not to draw*) before its nine drawing rules, which is the
ordering phase 2 of `probe:svg` measures.

---

## 5. HTTP API

All responses are JSON except `/api/chat`, which is `text/event-stream`. CORS
echoes the request `Origin` with `Vary: Origin` (the SPA is same-origin; this
exists for curl and local tooling). `OPTIONS` on any `/api/*` path returns `204`
with the CORS headers.

### `POST /api/chat`

```jsonc
{
  "messages": [
    { "role": "system", "content": "optional — replaces the default prompt" },
    { "role": "user", "content": "Explain B-trees" },
    { "role": "assistant", "content": "…prior turn…" },
    { "role": "user", "content": "Now compare to LSM trees" }
  ]
}
```

Roles are `system` | `user` | `assistant`. Blank-content messages are dropped
rather than rejected; at least one `user` message must survive that filter.

Response headers: `Content-Type: text/event-stream; charset=utf-8`,
`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no` (stops
intermediaries coalescing the stream), and `X-ChatDDB-Model` naming the model
that served the request.

Frame sequence:

```
: chatddb stream open

data: {"choices":[{"delta":{"content":"B-trees "}}]}

data: {"choices":[{"delta":{"content":"keep data sorted…"}}]}

data: [DONE]
```

A failure discovered *after* headers are committed arrives as a frame rather
than a status code, and is always followed by `[DONE]`:

```
data: {"error":{"message":"Stream interrupted: …","type":"stream_error"}}

data: [DONE]
```

| Status | Meaning |
| --- | --- |
| `200` | Streaming (individual frames may still carry an error) |
| `400` | Malformed body, or a limit exceeded, or the model was refused |
| `405` | Not a POST |
| `429` | AgentRouter rate limit or quota |
| `499` | Client hung up — nothing is sent back |
| `500` | Upstream failure, bad key, or an unexpected error |
| `503` | No API key configured (the UI reads this as "mock instead") |

#### Generating an image mid-turn

When the image chain is configured, the request carries one tool —
`generate_image(prompt: string)` — and the system prompt gains a clause saying
when to use it. If the model calls it, the whole round trip happens **before the
response headers are committed**: generate, store in R2, hand the result back
upstream, get the final text, and only then open the stream. Nothing capable of
restarting a turn sits downstream of the first client byte, which is the same
invariant `completeWithFailover` protects.

`peekToolCalls` in `worker/sse.ts` is what makes that possible without giving up
streaming. It reads the upstream response far enough to see whether the first
signal is a tool call or ordinary content; text is replayed intact through a new
stream, so an ordinary turn is not buffered and loses nothing.

The follow-up request deliberately omits `tools`. The model has had its turn with
it, and re-offering invites a second call the loop would spend a round refusing —
each round being another full round trip in front of the user's first token.
`MAX_TOOL_ROUNDS = 3` is the backstop for a gateway that produces one anyway, and
one image per turn is enforced separately.

The generated file attaches to the **assistant** row, so it comes back with the
transcript exactly like a button-generated image. `X-ChatDDB-Generated-File`
carries its id; like `X-ChatDDB-Upstream` it is deliberately *not* in
`Access-Control-Expose-Headers`, so no browser client can read it yet.

A generation that fails — spent budget, refused prompt, provider down — is not a
failed turn. The tool result says so in plain words and the model relays it, so
the user gets "I couldn't make that image because today's limit is reached"
rather than a 429. Budgets consumed: `tool_image` (day) *and* `image`
(minute + day), tighter one first so a refusal does not waste the shared counter.

### `GET /api/health`

```json
{
  "ok": true,
  "service": "chatddb-f5",
  "model": "gpt-5.6-sol",
  "provider": "agentrouter",
  "configured": true,
  "ready": {
    "upstream": true, "db": true, "r2": true, "auth": true, "signedUrls": true,
    "fallback": true, "image": true, "imageFallback": true
  },
  "fallbackProvider": "freemodel", "fallbackModel": "gpt-5.5",
  "imageFallbackProvider": "pollinations", "imageFallbackModel": "flux"
}
```

Always `200`. When `configured` is `false`, a `detail` field explains what is
missing. The key itself is never echoed.

`ready.imageFallback` is **armed**, not enabled: it is false when the key is
absent, when `POLLINATIONS_ENABLED` is `"false"`, *and* when image generation
itself is off, since a backup behind a disabled feature is not armed in any
useful sense. A deployment that left the switch on but has no key is reported the
same way a missing binding is — as a line in `missing`:

```
"missing": ["POLLINATIONS_API_KEY (optional; image fallback unconfigured)"]
```

Silence there means nobody asked for a backup. That line means one was asked for
and cannot run, which is a misconfiguration rather than a choice.

### `GET /api/models`

Proxies AgentRouter's `/v1/models` so you can confirm what the key can reach —
useful when a model name is rejected. `503` if unconfigured, `500` if AgentRouter
is unreachable.

```bash
curl -s http://localhost:5173/api/models | grep -o '"gpt-5\.6[^"]*"'
```

### `POST /api/images`

Generates one image from a prompt, on Workers AI with Pollinations behind it.
Plain JSON, not SSE — the model produces a whole image in one shot, so there is
nothing to stream.

```jsonc
// request
{ "sessionId": "…optional…", "prompt": "a red bicycle on a white background" }

// 201
{ "sessionId": "…", "messageId": "…", "userMessageId": "…", "file": { /* PublicFile */ } }
```

The image is stored in R2 through the same path as an upload and attached to the
**assistant** message, so it comes back with the transcript and renders on reload
with no special handling. `file.origin` is `"generated"`, which is what the UI
keys full-size rendering off — an uploaded attachment stays a 36px chip.

Neither AgentRouter nor freemodel can serve this. AgentRouter *has* the route,
but every image model on this account's tier answers `503 无可用渠道` ("no
available channel"), and its `/v1/models` lists three models, all text. Hence a
third provider.

**It spends a shared budget.** `@cf/black-forest-labs/flux-1-schnell` bills 4.80
neurons per 512×512 tile plus 9.60 per step, so a 1024×1024 four-step image is
~57.6 neurons against a free allowance of 10,000 **per account per day** — about
173 images a day for *all* users combined, resetting at 00:00 UTC. That is why
`RATE_IMAGE_PER_MIN`/`RATE_IMAGE_PER_DAY` default to 3 and 20, well below what one
user could otherwise drain. Past the allowance, requests on the Workers Free plan
fail rather than bill, and surface as a 429 naming the reset time.

Workers AI has no local mode: `wrangler dev` reaches the real account and spends
from the same allowance, which is why the `ai` binding is declared `remote: true`.

`503 not_configured` when the `AI` binding is absent or `IMAGE_ENABLED` is
`"false"`; `GET /api/me` reports `imageGeneration` so the composer can hide its
toggle rather than offering a button that always fails.

#### The backup provider

That shared daily wall is the reason there is a second provider. When Workers AI
cannot serve, `generateImage` in `worker/images.ts` asks Pollinations instead —
same shape as `completeWithFailover`, minus the streaming concerns, since an
image is one indivisible result. Nobody is told: the response is identical apart
from `file.genModel`, which reads `pollinations/flux` rather than the bare `@cf/…`
id. The prefix exists because `flux` alone would be indistinguishable from the
Cloudflare model of the same family.

The crossover fires on exactly two error classes:

| Type | Crosses over? | Why |
| --- | --- | --- |
| `image_quota_exhausted` | **yes** | "This provider cannot serve right now" — a different one can disprove it |
| `image_model_unavailable` | **yes** | Same claim; also covers a provider that is simply down |
| `image_prompt_refused` | no | A refusal is an answer — see below |
| `image_failed` / `image_empty` / `image_malformed` | no | Something unexpected happened, not an unavailable provider, and every attempt spends real budget |

A prompt one model's safety filter rejected must **not** be quietly resubmitted
to a model with a different policy. That turns a refusal into a search for the
laxest filter on the chain, and it makes the deployment's effective content
policy "whichever provider happens to be last".

Each crossover writes an `image_failover` activity row — the same shape as
`upstream_failover`, so the admin feed reads the two alike — and it is written
inside `generateAndStore` rather than by the caller, so it lands whether or not
the request that triggered it goes on to succeed.

**The two providers do not share an error vocabulary**, which is why
`classifyWorkersAi` and `classifyPollinations` are separate functions. Workers AI
throws `Error`s worded in its own terms ("capacity", "quota", "no such model");
Pollinations answers with an HTTP status and a JSON envelope. Measured against
the live endpoint:

- An unknown model is `400 BAD_REQUEST`: `Invalid model or alias: "turbo". …`.
  "no such model" never appears.
- **Exceeding the request pace answers `401 UNAUTHORIZED`** with
  `Authentication required. Please provide an API key …` — not `429`, and not a
  word about rate limits. An unrecognised bearer token is not rejected either; it
  is silently treated as anonymous, so a stale key and a spent allowance are
  indistinguishable on the wire. The 401 branch says both things for that reason.

`scripts/stub-pollinations.mjs` reproduces those envelopes verbatim, including
the 401, so a Worker that only handled a tidy 429 fails the test it should fail.

---

## 6. The streaming pipeline

### Why the Worker re-emits instead of piping through

`worker/sse.ts` parses the upstream body and writes fresh frames. That buys
three things a pass-through cannot:

- **A fixed shape.** The client only ever handles
  `{"choices":[{"delta":{"content":…}}]}` and `[DONE]`, whatever framing the
  upstream provider uses. The parser also accepts a final chunk that carries a
  whole `message.content` instead of a delta, which some relays send.
- **Reasoning tokens dropped.** `gpt-5.6-sol` is a reasoning model and the UI
  has nowhere to display its intermediate reasoning.
- **Post-header error reporting.** Once headers are out the status code is
  fixed, so mid-stream failures must be reported in-band as an error frame.

If upstream answers with a plain JSON body instead of a stream — a relay
ignoring `stream: true` — `pumpJsonBody` handles it and emits the same frames.
If the stream ends without ever producing content, the client gets an
`empty_completion` error frame rather than a silently blank message.

### The figure gate

Assistant text passes through `FigureGate` (`worker/lib/figureGate.ts`) on its
way out. Prose is forwarded unchanged; a ` ```svg ` fence is **buffered** until
its closing fence arrives, sanitised, and only then emitted.

Buffering is necessary because half an `<svg>` is not markup any parser can
judge safe, and it is cheap because AgentRouter delivers the whole completion in
one frame anyway (see below) — there is no real stream being held up. It also
does not violate the no-restart invariant in §5: the gate withholds bytes it has
not yet written, it never rewrites bytes already sent.

Three things fall out of that design:

- **The placeholder is the opening fence.** Content frames append and cannot be
  replaced, so a literal `rendering figure…` token would become permanent
  message content. Instead the gate emits a bare ` ```svg ` the instant it sees
  one, which is enough for `SvgFigure` to show its drawing skeleton. Final
  stored content is exactly ` ```svg\n<sanitised>\n``` `.
- **The buffer is bounded**, by `MAX_SVG_BYTES - 1024` and by a 30-second
  deadline. `Date.now()` is pinned between I/O in workerd, but the gate only
  advances on stream reads, which *are* I/O, so the clock does move here. On
  overflow the figure is closed, repaired (`</svg>` appended), sanitised, and
  captioned *"this figure was cut off before it finished drawing"*; the rest of
  the abandoned block is discarded in a `skip` state so the model's own closing
  fence cannot leak out as a stray unmatched one. Nothing is silently swallowed.
- **`sawContent` keys off upstream text, not gate output.** A chunk that is
  entirely the start of a figure emits nothing, and must not be mistaken for an
  `empty_completion`.

`drainGate()` runs before *every* error frame, so a figure interrupted by an
upstream failure appears above the failure in the order it happened. `flush()`
is idempotent, which is what makes the belt-and-braces drain in
`toClientStream`'s outer catch harmless.

Gated output goes into `sink.parts`, so the transcript persisted to D1 is the
same sanitised text the reader saw — the database never holds markup the browser
was not allowed to render.

### Two SVG sanitisers, deliberately different

`sanitizeSvg` in the Worker is the primary control: `HTMLRewriter` (lol-html) —
a real parser, not a regex — over a strict allowlist of elements and attributes.
Everything else is dropped with `element.remove()`, which takes the subtree with
it and so closes the mXSS bypass where an attacker unwraps a disallowed element
to promote its children.

Two engine facts the allowlists depend on, both verified against a real build
rather than assumed: lol-html reports `tagName` and attribute names
**pre-lowercased**, so every entry in the allowlists is lowercase
(`gradientunits`, not `gradientUnits`); and it passes untouched attribute *bytes*
through verbatim, so the original casing survives into the output and camelCase
SVG attributes keep working.

`SvgFigure` then re-sanitises in the browser with DOMPurify before the fragment
touches the DOM. This is defence in depth and it is a *different implementation
on purpose* — sharing an allowlist between the two would mean a single bug
defeats both layers. DOMPurify is loaded with a dynamic `import()` so it lands in
its own ~27 kB chunk rather than the main bundle.

The client pass also does one thing only it can: `namespaceIds` rewrites every
`id` and matching `url(#…)` reference with a per-instance `useId()` prefix, so
two figures in one reply cannot collide over a gradient or marker id.

`react-markdown` runs **without `rehype-raw`**, so raw HTML in a reply is
stripped as it always was. Routing SVG through a fenced code block rather than
inline markup is what avoids ever needing to turn that off.

### AgentRouter does not really stream

AgentRouter waits for the whole completion upstream, then synthesises a
single-frame SSE response — the chunk arrives tagged `"id":"chatcmpl_temp"` and
carries the entire answer. Measured directly against the gateway: a 318-char
reply came back as one data line at +3.8 s.

So the progressive typing effect is produced **client-side** by `paced()` in
`src/lib/api.ts`:

- Deltas of 24 characters or fewer pass straight through — genuinely
  incremental streams are unaffected, and if AgentRouter ever starts real
  streaming this stops doing anything on its own.
- Longer deltas are split on word boundaries (never mid-token, so Markdown
  never renders half a fence) and revealed against a ~700 ms deadline.
- Pacing checks `signal.aborted` between words, so **Stop** halts it instantly.

The text is already final when it reaches `paced()`; this only controls how it
is revealed.

### Why pacing is not in the Worker

It was implemented there first and removed. Two measured problems:

1. `setTimeout` in workerd costs roughly 30 ms per call, so a fixed per-frame
   sleep produced 102 frames spread over 3104 ms against a 900 ms budget.
2. Correcting for that needs the loop to measure its own drift — but Cloudflare
   **pins `Date.now()` between I/O operations** as a Spectre mitigation, so
   elapsed time always reads as zero and every iteration believes it is ahead
   of schedule. Two attempts landed at 3746 ms and 1857 ms.

Worker-side pacing also bills the sleep as wall-clock time. The Worker now adds
a measured 0 ms; `performance.now()` in the browser is real, and the client
version lands at 698–719 ms against its 700 ms budget.

---

## 7. AgentRouter integration

### The client whitelist

AgentRouter's edge rejects unrecognised clients *before* the request reaches the
router:

```json
{"error":{"message":"unauthorized client detected, ..."},"type":"unauthorized_client_error"}
```

The same request with a `claude-cli/<version> (external, …)` User-Agent is
accepted. A useful diagnostic: with an accepted UA, a bad key fails with
`new_api_error` instead — so the two failure modes are distinguishable.

`AGENTROUTER_USER_AGENT` is therefore mandatory rather than cosmetic, and is a
`var` so the value can change without a code edit if the accepted pattern moves.
Requests also carry `X-App: cli`.

### Reasoning-model parameters

`gpt-5.6-sol` rejects the classic chat parameters, so `buildBody` sends:

| Field | Value |
| --- | --- |
| `model` | `AGENTROUTER_MODEL` |
| `messages` | validated history, system prompt first |
| `stream` | `true` |
| `max_completion_tokens` | `MAX_OUTPUT_TOKENS`, omitted when `0` |
| `reasoning_effort` | only when `REASONING_EFFORT` is set |

No `temperature`, `top_p`, or `max_tokens` — reasoning models reject a
non-default `temperature`, and `max_tokens` is not the parameter they read.

### Retries and timeouts

`createChatCompletion` makes up to 3 attempts with 250 ms → 500 ms backoff,
retrying on `408, 429, 500, 502, 503, 504, 522, 524` and on transport errors.

**Retries only happen before any bytes reach the client.** A stream that dies
mid-flight is surfaced as an error frame, never silently restarted — restarting
would duplicate text the user has already read.

Each attempt gets its own `AbortController` carrying both the
`UPSTREAM_TIMEOUT_MS` time-to-first-byte timer (cleared as soon as headers
arrive) and a forwarder for client aborts. On success the forwarder is left
attached deliberately: a closed tab or a pressed Stop button must cancel the
upstream generation too.

---

## 8. Frontend architecture

State lives entirely in `App.tsx` — no state library. A `Conversation[]` array
holds everything; the active conversation is found by id.

```ts
interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  streaming?: boolean   // tokens still arriving
  error?: string        // generation failed
}

interface Conversation {
  id: string
  title: string          // derived from the first user message
  messages: Message[]
  createdAt: number
  updatedAt: number
}
```

### Turn orchestration

`runAssistantTurn(conversationId, history)` is the single path to a reply,
shared by sending, regenerating, and editing:

- **Send** — appends the user message, then runs a turn. A new conversation is
  created if none is active, titled from the first line (40 chars max).
- **Regenerate** — pops trailing assistant messages, then reruns from there.
- **Edit** — rewrites a user message, drops everything after it (the old branch
  is gone, as in ChatGPT), and regenerates. Editing the first message retitles
  the conversation.

Switching conversation, starting a new chat, or deleting the active chat aborts
any in-flight stream first.

### Render performance

Streaming mutates the last message on every chunk, which naively re-renders and
re-parses the Markdown of every message in the thread. Two mitigations:

- `MessageItem` is wrapped in `memo()`.
- `App.tsx` keeps a `latest` ref mirroring `{conversations, activeId,
  streaming}`, so the callbacks passed to messages read through the ref and keep
  a stable identity across renders instead of being rebuilt each time.

### Persistence

`localStorage`, debounced 400 ms because streaming updates arrive fast. Keys:
`chatddb.conversations` and `chatddb.theme`. Every read and write is wrapped —
a full or unavailable store degrades to in-memory rather than breaking the app.
D1 will replace this (§13).

Theme defaults to `prefers-color-scheme`, is toggleable, and is applied by
adding `.dark` to `<html>`; an inline script in `index.html` sets it before
first paint so there is no flash.

### Mock fallback

When `/api/chat` cannot be reached, or answers `404`/`502`/`503`, `streamChat`
streams a canned Markdown reply that exercises streaming, tables, and
highlighted code. This keeps the UI fully testable with no backend — and is why
the Worker never reuses those three status codes for real failures.

---

## 9. Error handling

Mapping from failure to what the user sees:

| Failure | `type` | Status | UI |
| --- | --- | --- | --- |
| No API key | `not_configured` | 503 | Mock reply streams |
| Worker not running | — | — | Mock reply streams |
| UA rejected by AgentRouter edge | `unauthorized_client_error` | 500 | Error note naming `AGENTROUTER_USER_AGENT` |
| Key rejected (401/403) | `invalid_api_key` | 500 | Error note linking the token console |
| Rate limit / quota | `rate_limited` | 429 | Error note with upstream detail |
| Model refused | `model_unavailable` | 400 | Error note pointing at `/api/models` |
| Gateway unreachable after retries | `upstream_unreachable`, `upstream_retries_exhausted` | 500 | Error note |
| Bad request body | `invalid_request` | 400 | Error note |
| Stream dies mid-reply | `stream_error` | 200 + frame | Partial text kept, error note under it |
| Model returned nothing | `empty_completion` | 200 + frame | Error note suggesting a retry |
| User pressed Stop | — | 499 | Partial text kept, no error |

Error notes render in a red-bordered box under the message, and the message's
regenerate button becomes **Try again**. An aborted turn is not an error: the
frontend suppresses the message when `signal.aborted`.

Server-side logging uses `console.warn` for a missing key and `console.error`
for upstream and unexpected failures, both prefixed `[chatddb]`. Observability
is enabled in `wrangler.jsonc`, so these reach `wrangler tail` and the
dashboard.

---

## 10. Testing

Four Playwright drivers run headless Edge against a live dev server and write
screenshots to `shots/` (gitignored). Start `npm run dev:all` first.

| Test | Asserts |
| --- | --- |
| `node smoke.mjs` | Welcome screen, dark-mode toggle, send a message and get a reply, sidebar lists the chat, mobile viewport collapses the sidebar into an overlay |
| `node smoke-backend.mjs` | **Real** `gpt-5.6-sol` reply: fails immediately if `/api/health` reports `configured:false`, then samples the assistant bubble every 60 ms and requires ≥80 chars, ≥3 growth steps, and text that is not the mock |
| `node smoke-edit.mjs` | Edit flow: two turns, edit the first message, expect one user message left, new text present, dropped turn gone |
| `node smoke-mobile.mjs` | Mobile viewport collapses to the hamburger and the overlay sidebar opens — screenshot-only, no assertions |

Only `smoke-edit.mjs` exits non-zero on console errors; `smoke.mjs` and
`smoke-backend.mjs` print them under `CONSOLE_ERRORS` for you to read, and
`smoke-backend.mjs` fails only on its content assertions. Typical output:

```
HEALTH: {"ok":true,...,"configured":true}
GROWTH_STEPS: 11  FINAL_CHARS: 485  SPREAD_MS: 706
PASS: real gpt-5.6-sol reply streamed progressively into the UI.
```

The three non-backend tests key off the assistant bubble filling in rather than
any fixed string, so they pass against the real Worker and the mock fallback
alike. `smoke-backend.mjs` is deliberately the exception — a mock reply would
make a broken backend look healthy.

### Selectors tests rely on

Changing these breaks the suite: `textarea[aria-label="Message ChatDDB"]`,
`button[aria-label="Send message"]`, `button[aria-label="Stop generating"]`,
`button[aria-label="Edit message"]`, `textarea[aria-label="Edit message"]`,
`button[aria-label="Open sidebar"]`, `aside nav[aria-label="Chat history"]`,
`div.whitespace-pre-wrap` (user bubbles), and `[data-role="assistant"]` — the
last exists only as a test hook on the assistant message root.

### Backend smoke tests

These drive the Worker over HTTP rather than a browser, and each needs a Firebase
ID token in `CHATDDB_TOKEN` (`await firebase.auth().currentUser.getIdToken()` in
a signed-in tab).

| Script | Asserts |
| --- | --- |
| `npm run smoke:failover` | A real `POST /api/chat` survives a dead primary: response headers, the assistant row's `model_used`/`model_provider`, the `upstream_failover` row, the session title |
| `npm run smoke:image-failover` | Workers AI dead → Pollinations serves: the `image_failover` row, `gen_model` recording the provider that actually drew it, `limitImage` still consumed — then every branch of `classifyPollinations` in the other direction |
| `npm run smoke:chat-image-tool` | The `generate_image` path: an implicit mid-conversation request attaches an image and consumes a `tool_image` slot; an ordinary question fires nothing; a request past the daily cap gets a plain-text explanation rather than a 429 |

Both failover scripts point the primary at something broken using
`wrangler dev --var` overrides, so `.dev.vars` is never touched, and both drive
the backup against a local stub (`npm run stub:gateway`,
`npm run stub:pollinations`) so no metered credit is spent. Each script's header
has the exact three-terminal invocation, including the kill-switch run —
`EXPECT_FAILOVER=0` with `FALLBACK_ENABLED:false` or
`POLLINATIONS_ENABLED:false`, which asserts the backup *stops*. A backup that
cannot be switched off is a dependency, not a backup.

`smoke:chat-image-tool` is the exception on cost: every case runs a real
completion through AgentRouter, and its first case draws a real image on the
account's shared allowance. There is no way to test "does the model reach for the
tool" against a stub.

### The SVG tests run in workerd, not Node

`smoke:svg-sanitizer` and `smoke:figure-gate` each boot a throwaway one-route
Worker from `scripts/svg-sanitizer-harness/` and `scripts/figure-gate-harness/`
(ports 8792 and 8793) and drive it over HTTP. Neither needs a key or spends
anything.

The harness imports the **shipped** module rather than a copy. That is the whole
point: `HTMLRewriter` exists only in workerd, so a Node re-implementation would
be testing a different parser from the one that runs in production — which for a
sanitiser is testing nothing.

| Script | Cases |
| --- | --- |
| `npm run smoke:svg-sanitizer` | 22: `<script>`, `on*` handlers, `<foreignObject>`, `<use href>`, `<image href>`, `<style>` with `url()`, `<animate>`, mXSS-by-unwrapping, camelCase attribute survival, oversize rejection |
| `npm run smoke:figure-gate` | 35 across eight groups: prose untouched (4), placeholder timing (6), fence markers split across chunks (3), sanitisation (6), truncated fence (7), overflow (4), unusable figures (2), two figures in one reply (3) |

The gate harness returns the pieces emitted *per push*, not just the
concatenation, so the tests can assert **when** the placeholder appeared rather
than only that it did.

On Windows, both harnesses spawn Wrangler as `process.execPath` plus the literal
`node_modules/wrangler/bin/wrangler.js` path. Node 22 cannot `execFileSync` a
`.cmd` shim (EINVAL), and `shell: true` re-splits arguments on spaces, which
breaks any path containing one.

### Probes

Probes measure a provider's behaviour rather than this code's. They exist because
several decisions here turn on facts no amount of reading the docs establishes.

| Script | Question it answers |
| --- | --- |
| `npm run probe:vision` | Does `gpt-5.6-sol` accept image content parts? |
| `npm run probe:freemodel` | What shape does the backup gateway want (`max_tokens` vs `max_completion_tokens`, reasoning effort)? |
| `npm run probe:tools` | Does the model call tools reliably, *and* does it do so over a streaming request? |
| `npm run probe:svg` | Can the model draw a usable technical figure — and does it know when not to? |

`probe:tools` runs five phases, five runs each, and reports hit rates rather than
a single result — a tool that fires four times out of five is a different feature
from one that fires five. Its phase 5 is why the tool-decision leg keeps
`stream: true`: `tool_calls` arrive as `delta` fragments (~150 of them per call)
over a streaming response, so they can be reassembled by `index` without giving
up genuine streaming on the backup gateway.

`probe:svg` has two phases, narrowable with `PHASE=1` / `PHASE=2` and `RUNS=n`.

**Phase 1, quality** asks for five figures — pole-zero, Bode, RC low-pass, free
body, z-plane — and checks each for: parses as XML, has a `viewBox`, has a
`<title>` (which becomes the figcaption), carries text labels, uses
`currentColor` so it survives the dark theme, is inert (no script, handler or
external reference), and contains the specific numbers the prompt named. It then
renders every result to `shots/svg-probe/*.png`. That last step is not
decoration: structural checks cannot tell you whether a pole is in the right
half-plane, so the probe prints a line saying so and expects a human to look.

**Phase 2, restraint** is the one that justified the prompt clause. It sends
three prompts that deserve a figure and four adversarially chosen ones that do
not — a derivation, a TCP-vs-UDP comparison, a request for linked-list code, and
plain prose — and asserts a figure appeared or did not. Its spec deliberately
mirrors the shipped `DIAGRAM_CLAUSE` *including* the base ChatDDB system prompt;
an earlier version told the model to "reply with ONLY a fenced block", which
measures obedience and cannot measure judgement.

---

## 11. Deployment

```bash
npm run secret     # first time only: pushes AGENTROUTER_API_KEY
npm run deploy     # build + wrangler deploy
```

`wrangler deploy` uploads `dist/` as static assets alongside the Worker, so one
command ships frontend and backend together. Dry-run first if you want to check
bindings without publishing:

```bash
npx wrangler deploy --dry-run
```

`.dev.vars` is local-only and never uploaded — production reads the secret from
Cloudflare. Secrets do not appear in `wrangler.jsonc`, `wrangler types` output,
or `/api/health`.

Operational commands:

```bash
npx wrangler tail                  # live logs
npx wrangler deployments list      # deploy history
npx wrangler rollback              # revert to the previous version
npx wrangler secret list           # names only, never values
```

After editing `wrangler.jsonc`, rerun `npm run cf-typegen` — the generated
`worker-configuration.d.ts` otherwise still describes the old bindings.

---

## 12. Troubleshooting

**Replies are the mock, not the model.** `curl /api/health`. If `configured` is
false, the Worker has no usable key: check `.dev.vars` exists, holds a real key
rather than `sk-replace-me`, and that `wrangler dev` was restarted after it was
created.

**`unauthorized_client_error`.** AgentRouter's edge refused the client. Confirm
`AGENTROUTER_USER_AGENT` still matches the `claude-cli/<version> (external, …)`
shape; the accepted pattern is theirs to change.

**Health says the key is missing but the log shows it loading.** Almost always a
stale `wrangler dev` still holding port 8787 — the old process serves your
requests while the new one logs the binding. Check for more than one listener:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 8787 | Select-Object OwningProcess
```

`wrangler dev` runs a `node` supervisor above `workerd`; killing `workerd` alone
just makes the supervisor respawn it. Trace parents and kill the `node` PIDs:

```powershell
Get-CimInstance Win32_Process -Filter "ProcessId = <pid>" | Select ProcessId,ParentProcessId,Name
```

**Reply appears all at once.** Expected upstream behaviour (§6) — the pacing is
client-side, so check `paced()` was not bypassed and that the delta exceeded
`PACE_MIN_CHARS`.

**`model_unavailable`.** Ask what the key can actually reach:
`curl -s localhost:5173/api/models`.

**Type error after a config change.** Run `npm run cf-typegen`. Note that
`wrangler types` infers secret types from whatever is in `.dev.vars`, so the
generated `Env` differs between machines — which is why `WorkerEnv` in
`worker/index.ts` is declared standalone rather than extending it.

**Build fails with TS1294.** The worker project sets `erasableSyntaxOnly`;
constructor parameter properties are not allowed there. Declare fields
explicitly.

---

## 13. Roadmap

The next phase is persistence. Binding placeholders are already in
`wrangler.jsonc`, commented out:

```jsonc
// "d1_databases": [{ "binding": "DB", "database_name": "chatddb-f5-db", "database_id": "" }],
// "r2_buckets":   [{ "binding": "FILES", "bucket_name": "chatddb-f5-storage" }]
```

**D1 — `chatddb-f5-db`.** Move conversation history off `localStorage`. Needs
endpoints for list/create/rename/delete plus message append, and a shape close
to the existing `Conversation`/`Message` types (a `conversations` table and a
`messages` table keyed by conversation id, both timestamped). Nothing here is
implemented yet, including any notion of per-user ownership — with no auth,
history is currently per-browser by construction.

**R2 — `chatddb-f5-storage`.** File attachments: upload endpoint, references on
messages, and multimodal request bodies.

Also worth doing at some point: the client bundle is 537 KB (168 KB gzipped) in
one chunk, mostly `highlight.js` and the Markdown stack — code-splitting the
highlighter would cut first paint noticeably.

---

## Appendix A — naming constraints

The Cloudflare account already has a Pages project `chatddb` and D1 databases
`chatddb` and `prototype-chatbot-db` from an earlier prototype. Everything here
uses the **`chatddb-f5`** prefix to avoid collisions:

| Resource | Name | Status |
| --- | --- | --- |
| Worker | `chatddb-f5` | deployed |
| D1 database | `chatddb-f5-db` | planned |
| R2 bucket | `chatddb-f5-storage` | planned |

---

## Appendix B — known loose ends

- `errorStream()` in `worker/sse.ts` is exported but unused — pre-flight
  failures are reported as JSON status codes instead, which is the better
  behaviour. It is a leftover, not a dependency.
- The frontend's `Role` type is `'user' | 'assistant'`; the Worker additionally
  accepts `'system'`. Nothing in the UI can produce a system message today.
- `smoke-edit.mjs` filters console errors containing `502` — a holdover from
  when no Worker existed. Harmless, but it would mask a genuine 502.
- **A tool-generated image does not appear until the transcript is reloaded.**
  `src/` is untouched by the tool work, so nothing reads
  `X-ChatDDB-Generated-File` or renders an attachment that arrives mid-turn. The
  image is stored, attached to the assistant row, and comes back correctly with
  the transcript — it just is not there in the live bubble. Wiring it up is a
  frontend change: read the header in `streamChat`, and attach the file to the
  streaming assistant message the way a reloaded one already is.
- **The tool path adds a long pre-stream wait.** Generation plus a second
  AgentRouter round trip both happen before the first byte, so a turn that fires
  the tool can sit for tens of seconds where an ordinary one would already be
  typing. The waiting state exists — `MessageItem.tsx` shows a pulsing dot for a
  `streaming` assistant message with no content yet, which is inserted the moment
  the user sends — so this is not silent dead air. But that indicator says
  "thinking", not "drawing", and it looks the same at 2 seconds and at 40. If the
  header above gets read, this is the other thing worth doing with it.
- **`UpstreamError` has the bug `ImageError` used to have, and §9 above is
  optimistic because of it.** It extends `Error`, not `ApiError`, and
  `errorResponse` renders only `ApiError` — so every pre-stream chat failure
  reaches the client as a flat `500 internal_error` with the message replaced by
  "Something went wrong on our side.". The statuses and types in §9's table
  (`invalid_api_key` 500, `rate_limited` 429, `model_unavailable` 400) are built
  correctly and then discarded at the boundary; nothing between `postChat` and
  `errorResponse` maps them. `ImageError` was changed to extend `ApiError` during
  the image-failover work because a smoke test needed to assert classified types.
  The same one-line fix would work here, but it changes user-visible statuses on
  the main chat path, so it was left for a change that can be tested on its own
  rather than done in passing.
