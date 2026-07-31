# PHASE2-2 — Silent provider failover (AgentRouter → freemodel.dev)

**Status: code complete and verified as far as it can be without a live freemodel
call.** Compiles clean, lints clean, builds clean, 47/47 failover unit checks pass,
and `/api/health` reports the fallback armed and disarmed correctly against a running
Worker. Nothing has been deployed. Nothing has been committed (this project is not a
git repo).

Two things remain, both needing a human hand — see §8:
1. `npm run probe:freemodel` has never run, so `tokenParam` / `sendReasoningEffort`
   for `gpt-5.5` are still defaults rather than measurements.
2. The live crossover test needs a Firebase ID token from a browser.

Session date: 2026-07-31. This document is the complete handoff.

---

## 1. Why this work exists

The user's words: *"Sometimes AgentRouter's api fall back that creates dissatisfaction
to my clients. Can I use another provider that is ready in parallel."*

ChatDDB talks to exactly one upstream gateway, AgentRouter. It fails often enough that
the user's clients complain. The fix is a **second gateway as an automatic backup**.

The user then clarified the crucial constraint, which overrides the original "The UI
chose any of them. Fast switch." framing:

> **"The user does not see anything, everything happens in the background and it should
> be fast enough."**

So this is a **backend-only reliability change**. No model picker. No provider switch.
No UI at all. `src/` is not touched. `src/lib/apiTypes.ts:30` keeps
`provider: 'agentrouter'` unchanged.

## 2. Provider investigation (already done — do not repeat)

Two candidate gateways were investigated. Both docs pages are JS-rendered SPAs that
return an empty shell to `WebFetch`; all facts below came from probing the live APIs
and from reading the sites' own JS bundles. **These are verified, not assumed.**

### Lumosel (https://lumosel.vip) — investigated, then REJECTED by the user

- Base URL `https://api.lumosel.vip`, endpoint **`/v1/messages`** — the **Anthropic**
  Messages API, *not* OpenAI-compatible.
- Auth: `x-api-key: lumo_live_…` plus `anthropic-version: 2023-06-01`.
- Public catalogue at `https://api.lumosel.vip/api/models` (no key needed):
  `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `glm-5.2`, `gpt-5.6`,
  **`gpt-5.6-sol`**, `kimi-k3`, with per-Mtok pricing.
- **It was the only candidate that also serves `gpt-5.6-sol`**, the current default —
  but being Anthropic-shaped it needs a stream translator (~150 lines).
- The user chose freemodel instead.

### freemodel.dev — CHOSEN

- **OpenAI-compatible**: `POST https://freemodel.dev/v1/chat/completions`,
  `Authorization: Bearer`. Same wire format `worker/agentrouter.ts` already speaks,
  so **`worker/sse.ts` needs no changes at all**.
- No User-Agent whitelist (unlike AgentRouter).
- Public catalogue `GET https://freemodel.dev/v1/models` (no auth):
  `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`.
- **Does NOT serve `gpt-5.6-sol`.** This is the central wrinkle — see §5.
- Also exposes `/v1/responses` and an Anthropic route at `cc.freemodel.dev`; we use
  neither.
- Metered despite the name: $5 signup credit, then Pro/Max monthly tiers.
- ⚠️ During probing, `api.freemodel.dev/v1/models` returned
  `Failed to start container: Container service is restarting, try again shortly`
  while `freemodel.dev/v1/models` answered fine. **Use the `freemodel.dev` host, not
  the `api.` host.** Worth remembering: the backup has its own wobbles.

## 3. Decisions the user made

| Question | Answer |
|---|---|
| Which provider alongside AgentRouter | **freemodel.dev** (not Lumosel) |
| Fallback model | **`gpt-5.5`** — top tier freemodel advertises |
| Failover style | **Silent + automatic.** No UI, no picker |
| How fast to give up on AgentRouter | **Cross over fast** — network error / 5xx crosses immediately rather than exhausting the 3-attempts-per-key ladder; keep retrying in place only for 429 |

## 4. The approved plan

Full text at `C:\Users\khali\.claude\plans\woolly-crafting-yao.md`. Approved by the
user. Summary of the seven work items, which are also the task list:

1. **Probe freemodel body shape** — script written, **still not run** (§8a)
2. **Generalise `agentrouter.ts`** to a provider-agnostic `UpstreamConfig` — done
3. **Split the retry classes** — retry-in-place vs cross-now — done
4. **`worker/failover.ts`** — the orchestrator — done
5. **Wire into `worker/routes/chat.ts`** — done
6. **Env config, `/api/health`, activity signal** — done
7. **Verify end to end** — done except the two items in §8

Item 1 was planned as blocking the rest. It turned out not to be: making `tokenParam`
and `sendReasoningEffort` env-overridable meant the probe's answers could be applied as
config rather than code, so the structural work went ahead without it.

## 5. Two design decisions worth not re-litigating

**Model identity — registry says requested, DB says served.** The registry entry
(`worker/models.ts`) describes what the user *asked for*; the attempt carries what
actually *answered*. So:
- `ModelSpec.provider` stays the `'agentrouter'` literal. `src/lib/apiTypes.ts` untouched.
- `X-ChatDDB-Model` keeps returning `model.id` (`gpt-5.6-sol`) so the frontend sees
  nothing change.
- A new `X-ChatDDB-Upstream: freemodel` header is added **only when the fallback
  fired** — invisible to the UI, decisive under `curl`.
- `persistAssistant`/`persistFailure` record the truth: `model_used = 'gpt-5.5'`,
  `model_provider = 'freemodel'`.
- **No migration needed.** Verified: `chat_messages.model_provider` and `model_used`
  are nullable free-text `TEXT` with no CHECK constraint (`migrations/0002`), and
  `InsertMessage` (`worker/db/messages.ts:69-70`) already types both `string | null`.
  Likewise `ACTIVITY_ACTIONS` (`worker/db/activity.ts:12`) is a TS-only union with no
  DB constraint, so adding `'upstream_failover'` is a one-line change.

**The stream invariant.** `createChatCompletion` resolves at headers-in, *before* any
body byte is read, and `routes/chat.ts` only calls `toClientStream` on the returned
response. So the failover loop sitting above `createChatCompletion` **structurally
cannot** restart a stream that has already delivered bytes — which would duplicate text
the user already read. Preserve this: put the cross-provider loop in `failover.ts`,
never inside `toClientStream`.

## 6. What shipped

### `worker/agentrouter.ts` — widened, not split
Still the only upstream client. It speaks plain OpenAI `/v1/chat/completions` to
whichever gateway a config names, and **no function in it branches on `provider`** —
everything a gateway can disagree about is a config field. `provider` exists only to
label logs and to record which gateway answered.

- `ProviderId = 'agentrouter' | 'freemodel'`; `AgentRouterConfig` → `UpstreamConfig`
  (old name kept as an alias export).
- `userAgent` is now **optional** — AgentRouter's edge whitelists clients by
  User-Agent, freemodel has no such check, and sending a claude-cli UA to a gateway
  that never asked for one is just noise. `upstreamHeaders`, `listModels`, and
  `generateTitle` all spread it conditionally.
- `tokenParam` (`max_completion_tokens` | `max_tokens`) and `sendReasoningEffort`
  replace the hardcoded reasoning-model body shape. `generateTitle` honours both too.
- `UpstreamError.crossable` — false means "we malformed the request, a second gateway
  would refuse the same body". Set by `toUpstreamError`: false for any 4xx **except**
  401/403/429 and a 400 mentioning the model, which are outage shapes.
- **The retry classes are split** (this was the "cross over fast" decision):

| Failure | Behaviour |
|---|---|
| 429, 408 | `RETRY_IN_PLACE` — backoff, up to `MAX_ATTEMPTS`, then next key, then cross |
| 401 / 403 | next key immediately, **no backoff**; cross only once keys are exhausted |
| network error, 5xx | `CROSS_NOW` — abandon this gateway on first sight |
| 400 / other 4xx | throw, `crossable: false` |

  `CROSS_NOW` only crosses fast when there *is* somewhere to cross to. The new
  `CompletionOptions.crossFast` flag gates it, and `failover.ts` sets it for every
  gateway but the last — so a deployment with no fallback keeps the old 3×3 ladder
  exactly as it was. That regression is pinned by a test.

### `worker/failover.ts` — new, the orchestrator
`resolveProviders(env, modelId?)` → `[primary, fallback?]`. Still throws
`NotConfiguredError` without an AgentRouter key: the backup is metered, so it is a
backup and not a substitute. `resolveFallback(env)` returns null when
`FREEMODEL_API_KEY` is unset **or** `FALLBACK_ENABLED === 'false'` — and only that
exact string disables it, so a typo fails safe (armed).

`completeWithFailover(providers, messages, signal, onCrossover?)` walks the chain and
returns `UpstreamAttempt {res, cfg, provider, model, crossedOver}`. It stops the chain
on an abort (the user pressed Stop) and on a non-crossable error. `titleWithFailover`
does the same one-extra-pass for session names.

### `worker/routes/chat.ts` — wired
`postChat` builds the chain, overrides the model on the **primary only**, and threads
`attempt.model` / `attempt.provider` into `persistAssistant`. `persistFailure` takes the
gateway that refused *last*, so a both-down turn names the backup rather than implying
only the primary was tried. `getUpstreamModels` gained `?provider=freemodel` and
deliberately does **not** fail over — its whole job is to report what one specific
gateway said.

### Observability, three layers
1. `console.warn('[failover] from -> to (type, upstream NNN): msg')` — greppable.
2. A new `'upstream_failover'` activity action, `severity: 'warn'`, metadata
   `{from, to, reason, upstreamStatus, sessionId}`, written via `ctx.exec.waitUntil`.
   The admin filter dropdown is served from `ACTIVITY_ACTIONS`, so it appears there
   with no frontend change.
3. `/api/health` gained `ready.fallback`, `fallbackProvider`, `fallbackModel`.
   Top-level `ok`/`configured`/`model`/`provider` are unchanged — `smoke-backend.mjs`
   gates on `configured`.

### Config
`worker/env.ts` and `wrangler.jsonc`: `FREEMODEL_MODEL` (`gpt-5.5`),
`FREEMODEL_BASE_URL` (`https://freemodel.dev/v1`), `FALLBACK_ENABLED` (`"true"`), plus
`FREEMODEL_TOKEN_PARAM` and `FREEMODEL_REASONING_EFFORT` so the probe's answers can be
applied **without editing code**. `.dev.vars.example` documents all of it.
`.dev.vars` itself was never touched.

### Test infrastructure — new
- **`scripts/test-failover.mjs`** (`npm run test:failover`) — 47 checks, no network, no
  key, no Worker. Stubs `globalThis.fetch` and counts calls per host, which is how
  "crossed over on the *first* 503" is told apart from "crossed over eventually". Uses
  `node --experimental-strip-types` to import the Worker's `.ts` directly, so the code
  under test is the code that ships. **47/47 pass.**
- **`scripts/stub-gateway.mjs`** (`npm run stub:gateway`) — a fake OpenAI-compatible
  gateway on `:8799`. Streams one word per SSE frame, honours
  `stream_options.include_usage`, serves the non-streaming form `generateTitle` needs,
  and rejects a missing `model`/`messages` like a real gateway would. `STUB_FAIL=503`
  makes it refuse everything, for the both-gateways-down case. This is what lets
  failover be tested without spending metered credit.
- **`scripts/smoke-failover.mjs`** (`npm run smoke:failover`) — the live end-to-end
  test. Its header comments carry the exact three-terminal setup; it asserts the
  headers, then queries local D1 for `model_used`/`model_provider`, the
  `upstream_failover` row, and the session title.

## 7. What was verified, and how

| Check | Result |
|---|---|
| `npx tsc -p worker/tsconfig.json --noEmit` | clean |
| `npm run lint` | clean (2 pre-existing `only-export-components` warnings in `src/`) |
| `npm run build` | clean |
| `npm run test:failover` | **47/47** |
| `/api/health` with a fallback key | `ready.fallback: true`, `fallbackModel: "gpt-5.5"` |
| `/api/health` with `FALLBACK_ENABLED=false` | `ready.fallback: false`, no `fallbackModel` |
| `/api/health` top-level shape | unchanged; `smoke-backend.mjs` still passes its gate |
| Stub gateway wire shape | catalogue, SSE frames, `[DONE]`, and the title path all correct |

The unit suite covers, by branch: fast crossover on 503/500/unreachable (asserting the
primary was tried **exactly once**), 401 walking both keys before crossing, 429
retrying 3× in place first, a malformed 400 refusing to cross at all, a
`model_unavailable` 400 crossing, the crossover callback's arguments, abort
propagating without touching the backup, both-gateways-down surfacing a non-502/503
status, and a single-provider setup still spending its full ladder.

Worth knowing: the Worker was run with `--var KEY:VALUE` on the command line for all of
the above. That is how to test config changes here **without ever writing to
`.dev.vars`**.

## 8. What is left

### 8a. The probe has still never run
The user set `FREEMODEL_API_KEY` as a **Cloudflare secret** (confirmed present via
`npx wrangler secret list`), but secret values cannot be read back — by design — and
`.dev.vars` does not have the key. So `npm run probe:freemodel` still cannot run, and
**`tokenParam: 'max_completion_tokens'` / `sendReasoningEffort: true` for `gpt-5.5`
remain defaults inherited from AgentRouter rather than measurements.**

If they are wrong, freemodel answers 400 on every crossover — the failover would look
armed and be useless. To fix, either add the key to `.dev.vars`:

```
FREEMODEL_API_KEY=<the key>
```

or pass it inline for one run (the probe prefers an existing env var over `.dev.vars`):

```
FREEMODEL_API_KEY=<the key> npm run probe:freemodel
```

Then apply its answers as `FREEMODEL_TOKEN_PARAM` / `FREEMODEL_REASONING_EFFORT` vars.
No code change either way.

### 8b. The live crossover test needs a browser token
`POST /api/chat` requires a Firebase ID token and there is deliberately no dev bypass.
The setup is scripted and ready; run the three terminals in
`scripts/smoke-failover.mjs`'s header, with the token from
`await firebase.auth().currentUser.getIdToken()`.

Both crossover branches are worth running, because they exercise different code:
`--var AGENTROUTER_BASE_URL:http://127.0.0.1:9/v1` (network error → immediate cross)
and `--var AGENTROUTER_API_KEY:sk-bad` (401 → keys exhausted → cross). Then
`--var FALLBACK_ENABLED:false` with `EXPECT_FAILOVER=0` to prove the kill switch.

### 8c. Deploying
Not done, and **not to be done without asking**. When it is: the vars in
`wrangler.jsonc` ship with `npm run deploy`; `FREEMODEL_API_KEY` is already a secret.

### 8d. Unrelated observation, flagged not fixed
`npx wrangler secret list` for this Worker shows only `AGENTROUTER_API_KEY_2`,
`AGENTROUTER_API_KEY_3`, and `FREEMODEL_API_KEY`. No `AGENTROUTER_API_KEY` (harmless —
`collectApiKeys` accepts any of the three), but also **no `FILE_URL_SECRET`**, which
signed file-view URLs need, and no `IP_HASH_SALT`. Worth checking against the live
`/api/health`. Predates this work.

## 9. Standing project rules that bit or nearly bit this session

- **Never overwrite or echo `.dev.vars`** — it is gitignored and holds live keys.
- **Always ask before deploying.** The Worker is live; `npm run deploy` is not to be
  run unprompted.
- Cloudflare naming is `chatddb-f5*` — plain `chatddb` belongs to an older prototype
  on the same account.
- House style: `.ts` extensions in imports, substantial explanatory file-header
  comments, no premature abstraction (this is why the client was widened in place
  rather than split into a `worker/providers/` tree).
- `toUpstreamError` must **never** return 404/502/503 — the frontend reads those as
  "no backend" and silently substitutes a mock reply, hiding real errors.
