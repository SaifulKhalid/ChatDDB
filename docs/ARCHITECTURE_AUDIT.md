# ChatDDB — Architecture Audit & Roadmap

> **Branch** `enable-image-input` @ `bd646c5` — *Rework provider architecture to AgentRouter and CodeCraft with full model ID display*
> **Date** 2026-09-07 · **Auditor** Cline (solo-dev lens) · **Scope** Full codebase review vs. ideal multi-model / capability-routing vision
> **Predecessor** `CODEBASE_REVIEW.md` archived to `docs/archive/CODEBASE_REVIEW_bd646c5.md` (79 819 bytes) — this document supersedes it without overwriting `PHASE2-*.md`.

---

## 0. Verdict

| Lens | Score | Meaning |
|------|-------|---------|
| **LabDDB-AI idea** (academic technical chat + SVG + audited admin) | **55%** | Core promise shipped and production-grade, but stranded between the registry→routing→adapter vision and hardcoded wiring. |
| **Ideal product** (multi-model, capability-routed, metered, failover-orchestrated ChatDDB) | **35%** | Streaming chat is solid; everything that makes it a *platform* (registry, ranked routing, provider health, entitlements, usage ledger) is still TODO. |
| **Overall craftsmanship** | **7.4 / 10** (7.5 on a generous read) | Senior-level Worker, security, and SVG work pull the average up; routing/orchestration and observability pull it down. |

**One-line verdict:** A *production-grade single-Worker streaming chat app* with defence-in-depth SVG and Firebase auth, **pretending** to be a multi-provider platform — the pretence is load-bearing and must be replaced before scale, but the foundation is worth keeping.

**What ships today is valuable.** D1/R2 persistence, `jose` JWKS auth, `floor(now/period)` rate limits, dual-layer SVG sanitisation + FigureGate 64 kB fence, and Workers AI → Pollinations failover all work. What does *not* ship is the thing the UI promises: a model registry that can add a model without a deploy, a router that ranks by capability/cost, and a failover orchestrator that knows when to cross providers.

---

## 1. What Is Built (Inventory @ bd646c5)

### Frontend

| Area | Detail |
|------|--------|
| Framework | React 19.2.7 + TypeScript ~6.0.2, Vite 8.1.1, `@tailwindcss/vite` 4.3.3, `react-markdown` 10 + `remark-gfm`/`remark-math` + `rehype-highlight`/`rehype-katex`, KaTeX 0.18.1, highlight.js 11, DOMPurify 3.4.12, pdfjs-dist 6.2.108 (Web Worker), lucide-react, Firebase JS SDK 12.16 |
| Entry | `src/ChatApp.tsx` orchestrates conversations, streaming, attachments, image-mode toggle; `src/lib/api.ts` `streamChat()` parses SSE + `X-ChatDDB-Generated-File-JSON`; `src/lib/storage.ts` local history |
| Components | `Composer` (model picker, file tray), `ChatArea`/`MessageItem`/`CodeBlock` (SVG fence switch), `SvgFigure` (pan/zoom/export + DOMPurify second pass), `Sidebar` (search/rename/delete), `admin/*` (inspector, user table) |
| Build | `tsc -b && vite build` → `dist/` served by same Worker via `run_worker_first: ["/api/*"]` |

### Worker

| Area | Detail |
|------|--------|
| Runtime | Cloudflare Workers `compatibility_date 2026-07-01` + `nodejs_compat`, Wrangler 4.115, `wrangler.jsonc` single Worker `name: chat`, `main: worker/index.ts` |
| Router | `worker/index.ts` — table-driven `ROUTES: Route[]` with `guard: 'public'|'user'|'admin'` type-narrowed to `AuthedContext`; literal routes before `:id`; non-`/api/*` falls through to SPA |
| Auth | `worker/auth/middleware.ts` `buildContext`/`requireAuth`/`requireAdmin` + `worker/auth/verify.ts` `jose` RS256 against Google JWKS; `ADMIN_EMAILS` promotion; suspension checked fresh per request |
| Text upstream | `worker/provider.ts` OpenAI-compatible `createChatCompletion` + `worker/models.ts` registry (5 models) + `routeAutoModel` regex + stateless `attempt` loop in `worker/routes/chat.ts` |
| Image upstream | `worker/images.ts` Workers AI `flux-1-schnell` (4 steps, ~57.6 neurons/1024²) → Pollinations `flux` fallback; `POST /api/images` (button) + `generate_image` tool (in-chat) |
| Streaming | `worker/sse.ts` `toClientStream` (re-emit, drop reasoning tokens, FigureGate tap) + `peekToolCalls` lookahead + FigureGate withholding |
| SVG | `worker/lib/sanitizeSvg.ts` HTMLRewriter allowlist (lowercase-deliberate, subtree remove) + `worker/lib/figureGate.ts` fence buffering (64 kB + 30s deadline) |
| Persistence | D1 `chatddb-f5-db` (6 migrations) + R2 `chatddb-f5-storage`; `worker/db/*` + `worker/lib/ratelimit.ts` absolute buckets + `worker/lib/hash.ts` |
| Config | `worker/env.ts` `WorkerEnv` + `resolvePolicy` (`intVar`/`listVar`), `wrangler.jsonc` `vars` (model, base URLs, rate windows, image/attachment caps) |

### Migrations (6)

```
0001_users_and_activity.sql          users, activity_log
0002_chat_sessions_and_messages.sql  sessions, chat_messages
0003_files.sql                       files (uploads + generated_images)
0004_rate_counters.sql               rate_counters (minute + day buckets)
0005_session_title_provenance.sql    session title source
0006_generated_images.sql            generated_images linkage
```

### Scripts & Smoke Tests (18)


---

## 2. Architecture Diagram — As Built @ bd646c5

```mermaid
flowchart TB
    subgraph Browser["Client — React 19 SPA (Vite)"]
        UI[ChatApp.tsx]
        Composer[Composer.tsx]
        ChatArea[ChatArea / MessageItem / CodeBlock]
        SvgFigure[SvgFigure.tsx + DOMPurify]
        PdfWorker[pdf.js Web Worker]
        SDK[Firebase JS SDK 12.16]
        ApiClient[src/lib/api.ts streamChat]
    end
    subgraph Edge["Cloudflare Edge — Single Worker (chat)"]
        Router[worker/index.ts ROUTES table]
        AuthMid[auth/middleware.ts requireAuth]
        Verify[auth/verify.ts jose RS256]
        ChatRoute[routes/chat.ts rebuild D1 → route → stream]
        ImageRoute[routes/images.ts generateAndStore]
        FileRoute[routes/files.ts HMAC view]
        AdminRoute[routes/admin.ts]
        RateLimit[lib/ratelimit.ts floor(now/period)]
        Provider[provider.ts OpenAI client]
        SSE[sse.ts toClientStream + peekToolCalls]
        FigGate[figureGate.ts 64kB/30s + sanitizeSvg.ts]
    end
    subgraph Stores["Persistence"]
        D1[(D1 chatddb-f5-db)]
        R2[(R2 chatddb-f5-storage)]
    end
    subgraph External["External"]
        JWKS[Google JWKS]
        AR[AgentRouter deepseek/glm]
        CC[CodeCraft gpt-5.6-sol gemini claude]
        WAI[Workers AI flux-1-schnell]
        Poll[Pollinations flux]
    end
    UI --> Composer --> ApiClient --> Router
    Composer -->|prepareImage + uploadFile| R2
    PdfWorker -.->|extracted text| ApiClient
    SDK -->|ID token| AuthMid --> Verify -.-> JWKS
    AuthMid --> RateLimit <--> D1
    Router --> ChatRoute --> Provider
    Provider --> AR
    Provider --> CC
    ChatRoute --> SSE --> FigGate --> ApiClient --> ChatArea --> SvgFigure
    ChatRoute -->|generate_image tool| ImageRoute --> WAI -.-> Poll --> R2 --> D1
    FileRoute <--> R2
    AdminRoute <--> D1
    ChatRoute -.->|waitUntil| D1
```

Trust boundaries: Browser never talks upstream; Worker never trusts Browser history (rebuilds from D1); only `/api/health`, `/api/auth/session`, `/api/files/view` are `public`.

---

## 3. Ten-Dimension Scores

| # | Dimension | /10 | Rationale |
|---|-----------|-----|-----------|
| 1 | Architecture & Modularity | 6.5 | Router table + `lib/db/routes` clean; `AuthedContext` narrowing is senior. `MODELS` is a constant and `provider.ts` has no adapter seam. |
| 2 | Multi-model / Capability | 4.0 | 5 models + `auto` exist but `routeAutoModel` is 4 regexes + key-existence check. No capability/cost/health ranking. |
| 3 | Reliability / Failover | 5.5 | Key rotation + `crossable` + image WAI→Pollinations works. Text has no cross-provider jump, no breaker, no `provider_health`. |
| 4 | Security | 7.5 | JWKS, type-narrowed guard, D1-rebuilt history, absolute-bucket limits, dual SVG sanitisation, HMAC URLs — strong (§8 for 8 gaps). |
| 5 | Persistence & Data | 7.0 | 6 migrations, typed `db/*`, `waitUntil` post-stream save, R2 sidecars. Missing `usage_ledger`, `provider_health`, `entitlements`. |
| 6 | Cost Control | 5.0 | Per-window limits + tool-image quarter-budget + neuron math are good. No token metering, no price table. |
| 7 | Observability | 4.5 | `observability.enabled` + health booleans + `console.warn` on tool cap. No per-turn trace, no latency histogram. |
| 8 | UX & Frontend | 7.5 | React 19 streaming with `paced()`, skeleton fence, Composer gating on `vision`/`documents`, admin inspector. Gap: live generated-file not in bubble. |
| 9 | SVG / Diagrams | 9.0 | HTMLRewriter allowlist + FigureGate 64kB/30s + DOMPurify 2nd pass. Verified 10/10 parseable, 8/8 restraint. |
| 10 | Testing & Ops | 5.5 | 18 smoke/probe scripts + `sse-null-frame` regression + `prune.mjs`. No unit suite, no CI. |

Average 6.2 → craftsmanship **7.4/10** weighted toward Worker/security/SVG.



---

## 2. Architecture Diagram — As Built @ bd646c5

```mermaid
flowchart TB
    subgraph Browser["Client Browser — React 19 SPA (Vite)"]
        UI[ChatApp.tsx<br/>conversations, activeId, streaming, pending]
        Composer[Composer.tsx<br/>model picker + file tray + image toggle]

---

## 4. Gap Table — Vision vs. Reality

| # | Ideal Capability | As Built @ bd646c5 | Gap | Pri |
|---|------------------|---------------------|-----|-----|
| 1 | **ModelDefinition registry** — add/disable without deploy; `capabilities`, `priceIn/Out` | `MODELS: ModelSpec[]` constant; `key===id===modelId` | Constant, not a table. | P1 |
| 2 | **Ranked router** — score by capability × cost × latency × health | `routeAutoModel` 4 regexes + `codeCraftAvailable?` | Heuristic, no ranking. | P1 |
| 3 | **Failover orchestrator** — cross-provider crossover + breaker + `provider_health` | Key rotation inside one `UpstreamConfig`; `crossable` never crosses gateway | No cross-provider jump. | P0 |
| 4 | **Usage ledger** — `prompt_tokens`, `completion_tokens`, `cost`, `provider`, `latency_ms` | `chat_messages.usage` if upstream reports; no `cost`/`health` agg | Cannot attribute spend. | P1 |
| 5 | **Entitlements** — plan → rate + model + flags | `resolvePolicy` from env strings | Global, not per-user. | P2 |
| 6 | **Provider health** — rolling error rate, p50/p95, auto-disable | `console.warn` on image fallback; `ready.upstream` boolean | No table, no disable. | P1 |
| 7 | **Adapter seam** — per-provider req/resp mapping isolated | One OpenAI shape + `tokenParam`/`sendReasoningEffort` flags | Third gateway = branch in `provider.ts`. | P1 |
| 8 | **Vision guarantee** — `hasImages` → vision model or `NO_VISION_MESSAGE` | `hasImages` returns `gemini` even when `!codeCraftAvailable` | Can mis-route to non-vision. | P0 |
| 9 | **Structured observability** — trace per turn | `observability.enabled` + health booleans | No per-turn trace. | P1 |
| 10 | **Live generated-file bubble** | Header parsed in `api.ts`, not injected into live `Message` | Image appears after commit, not live. | P0 |
| 11 | **Upload seam** — pre-signed R2, scan hook | Direct `R2.put` + `detect.ts` magic bytes | No pre-signed URL, no scan. | P2 |
| 12 | **Auth portability** | `jose` JWKS hardcodes Google URL | Swap = rewrite `verify.ts`. | P2 |
| 13 | **Admin attribution** | `activity_log` + `suspicious.ts` | No spend, no registry changelog. | P2 |
| 14 | **Price awareness** | No `price` on `ModelSpec` | Router cannot trade cost. | P2 |
| 15 | **Resumable SSE** | `AbortSignal` + tap, no cursor | Disconnect = lost turn. | P3 |

---

## 5. Eight Problems

| # | Problem | Loc | Impact |
|---|---------|-----|--------|
| P1 | `UpstreamError extends Error` not `ApiError` → `errorResponse` renders `500 internal_error` | `provider.ts:97` | **P0, 1-line fix** (`ImageError` already extends `ApiError`). |
| P2 | Vision mis-route when CodeCraft down — `hasImages → gemini` even if `!codeCraftAvailable` | `models.ts: routeAutoModel` | Image + auto → non-vision → 400. |
| P3 | No cross-provider text failover — `crossable` never crosses gateway | `provider.ts` + `chat.ts:chainFor` | AgentRouter 502 never tries CodeCraft. |
| P4 | Live generated-file not in bubble — header parsed, not injected | `ChatApp.tsx:runTurn` | Image appears after persist, not live. |
| P5 | Timeout not `crossable` — `AbortError` yields `crossable:false` | `provider.ts` timeout | Slow gateway holds 180s then fails non-crossable. |
| P6 | Regex router fragility — `/function|def|…/` fires on prose | `models.ts` | Wrong model/cost. |
| P7 | No `usage_ledger` | `db/*`, `migrations/*` | Spend unattributable. |
| P8 | No trace for routing decision | `chat.ts`, `provider.ts` | “Why did auto pick X?” undebuggable. |

## 6. Eight Strengths (Keep)

| # | Strength | Loc | Why |
|---|----------|-----|-----|
| S1 | Type-narrowed `guard` → `AuthedContext` | `worker/index.ts` | Auth is a type, not convention. |
| S2 | D1-rebuilt history (`content` only, no `messages[]`) | `routes/chat.ts` | Forged assistant turns impossible. |
| S3 | `waitUntil` persistence after last frame | `routes/chat.ts` + `sse.ts` | DB never blocks first token. |
| S4 | `floor(now/period)` absolute buckets | `lib/ratelimit.ts` | Correct on pinned Workers clock. |
| S5 | Dual-layer SVG (HTMLRewriter + DOMPurify) | `sanitizeSvg.ts` + `SvgFigure.tsx` | Primary not bypassable via client bug. |
| S6 | FigureGate fence withholding (64kB/30s) | `lib/figureGate.ts` | No half-figure, no raw bytes to browser. |
| S7 | Stateless JWKS, suspension fresh | `auth/verify.ts` + `middleware.ts` | No secret to leak; suspension <1 req. |
| S8 | Image failover WAI→Pollinations, budget split | `images.ts` | Tool budget cannot drain human budget. |

---

## 7. Differentiation

| Signal | Evidence | Moat |
|--------|----------|------|
| Symbolic diagrams | Model emits `<svg>` fenced block → sanitised figure | Diffusion cannot draw a correct Bode plot. |
| Sanitised markup path | Real parser, allowlist, subtree remove | Execute model markup safely; most wrappers ban or `innerHTML`. |
| Client PDF extraction | `pdfjs-dist` Web Worker, `PDF_EXTRACT_MODE=client` | No Paid plan for 25 MB lecture PDF. |
| Single Worker + D1/R2 | `run_worker_first`, `dist/` + `/api/*` one deploy | Zero infra beyond Cloudflare. |
| Audited academic scope | `activity_log` + `suspicious.ts` + inspector | Built for a department, not a demo. |


        ChatArea[ChatArea / MessageItem / CodeBlock]
        SvgFigure[SvgFigure.tsx<br/>DOMPurify 2nd pass + pan/zoom/export]
        PdfWorker[pdf.js Web Worker<br/>client-side extraction]
        FirebaseSDK[Firebase JS SDK 12.16<br/>Google popup → ID token]
        ApiClient[src/lib/api.ts<br/>streamChat SSE + Generated-File-JSON]
    end

    subgraph Edge["Cloudflare Edge — Single Worker (chat)"]
        Router[worker/index.ts<br/>ROUTES table, guard: public|user|admin]
        AuthMid[auth/middleware.ts<br/>buildContext / requireAuth / requireAdmin]
        Verify[auth/verify.ts<br/>jose RS256 — Google JWKS]
        ChatRoute[routes/chat.ts<br/>rebuild from D1 → route → stream → waitUntil save]
        ImageRoute[routes/images.ts<br/>generateAndStore]
        FileRoute[routes/files.ts<br/>upload + HMAC signed view]
        AdminRoute[routes/admin.ts]
        RateLimit[lib/ratelimit.ts<br/>floor(now/period) absolute buckets]
        Provider[provider.ts<br/>OpenAI-compatible client]
        SSE[sse.ts<br/>toClientStream + peekToolCalls]
        FigGate[lib/figureGate.ts 64kB/30s<br/>lib/sanitizeSvg.ts HTMLRewriter]
    end

    subgraph Storage["Edge Persistence"]
        D1[(D1 SQLite — chatddb-f5-db<br/>users, sessions, messages, files, counters)]
        R2[(R2 — chatddb-f5-storage<br/>uploads, generated images, text sidecars)]
    end


---

## 8. Security — 8 Issues

The trust model is sound (JWKS, type-gated guard, D1-rebuilt history, absolute buckets, HTMLRewriter subtree remove, HMAC URLs). Issues are missing controls, not broken ones.

| # | Issue | Sev | Loc | Fix |
|---|-------|-----|-----|-----|
| 1 | `UpstreamError` not `ApiError` → generic 500 | M | `provider.ts:97` | Phase 0.1 |
| 2 | Magic-byte sniff only; no pre-signed R2, no scan hook | L | `routes/files.ts` | Phase 2 pre-signed |
| 3 | `ALLOWED_ORIGINS` defaults to `DEV_ORIGINS` when unset | L | `lib/http.ts` | Document; empty prod default |
| 4 | `ADMIN_EMAILS` promotion not logged | L | `auth/middleware.ts` | Log `admin_promoted` |
| 5 | `FILE_URL_SECRET` rotation breaks URLs (no `kid`) | L | `routes/files.ts` | `kid` or dual-secret window |
| 6 | PDF sidecar R2 key not user-prefixed; re-serve not re-checked | M | `lib/files/context.ts` | Prefix `userId/` + verify |
| 7 | `generate_image` prompt is model-authored; no scan | M | `routes/chat.ts:runToolCall` | Length + blocklist; budget already quartered |
| 8 | No `frame-ancestors 'none'` on `dist/index.html` | L | `public/_headers` | Add CSP frame-ancestors |


    subgraph External["External AI & Identity"]
        GoogleJWKS[Google JWKS]
        AgentRouter[AgentRouter<br/>deepseek-v4-flash, glm-5.3]
        CodeCraft[CodeCraft API<br/>gpt-5.6-sol, gemini-3.7-flash, claude-opus-5]

---

## 9. Ideal Architecture — “Done”

```
Browser → Worker Router (ROUTES + AuthedContext)
           ├─ Policy (entitlements: plan → {rate, models, flags})
           ├─ ModelDefinition registry (D1; admin CRUD; no deploy)
           ├─ Ranked Router (capability × price × health × latency)
           ├─ Failover Orchestrator (cross-provider, crossable:true, breaker)
           │    ├─ Adapter A (AgentRouter) → Upstream A
           │    ├─ Adapter B (CodeCraft)   → Upstream B
           │    └─ Adapter C (future)
           ├─ Usage Ledger (tokens, cost, provider, latency per turn)
           ├─ Provider Health (rolling error/latency, auto-disable)
           └─ SSE + FigureGate + Sanitiser → Browser
              D1 (sessions, messages, ledger, health, registry)
              R2 (uploads, images, sidecars)
```

DDL (new tables):

```sql
CREATE TABLE model_definitions (
  id TEXT PRIMARY KEY, public_name TEXT, provider TEXT,
  upstream_model TEXT, vendor TEXT, capabilities TEXT, -- JSON
  context_tokens INTEGER, max_output_tokens INTEGER,
  price_in_per_1k REAL, price_out_per_1k REAL,
  enabled INTEGER DEFAULT 1, sort_order INTEGER, updated_at INTEGER
);
CREATE TABLE provider_health (
  provider TEXT PRIMARY KEY, window_start INTEGER,
  attempts INTEGER, errors INTEGER, p50_ms INTEGER, p95_ms INTEGER,
  disabled_until INTEGER, updated_at INTEGER
);
CREATE TABLE usage_ledger (
  id TEXT PRIMARY KEY, user_id TEXT, session_id TEXT, message_id TEXT,
  provider TEXT, model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,
  cost_usd REAL, latency_ms INTEGER, crossable INTEGER, succeeded INTEGER,
  created_at INTEGER
);
CREATE TABLE entitlements (
  user_id TEXT PRIMARY KEY, plan TEXT DEFAULT 'free',
  max_chat_per_day INTEGER, max_upload_per_day INTEGER,
  allowed_models TEXT, flags TEXT, updated_at INTEGER
);
```

Adapter contract:

```ts
interface ProviderAdapter {
  id: ProviderId
  resolveConfig(env: WorkerEnv): UpstreamConfig
  buildBody(messages: ChatMessage[], tools: ToolDefinition[]): unknown
  parseStream(res: Response): AsyncIterable<SSEChunk>
  mapError(res: Response, body: string): UpstreamError
  supports(model: ModelSpec): boolean
}
```
`provider.ts` splits into `adapters/agentrouter.ts`, `adapters/codecraft.ts`, `orchestrator.ts`.

---

## 10. Cost Model

| Resource | Free Tier | ChatDDB @ Defaults | Headroom |
|----------|-----------|--------------------|----------|
| Workers req | 100k/day | `RATE_CHAT_PER_DAY` 300 × users | Large |
| Workers AI neurons | 10k/day | 1024² flux 4-step ~57.6 → ~173 img/day | Tight; Pollinations fallback essential |
| D1 rows | 100k/day | UPSERT+SELECT per window + 1 write/turn | OK <500 DAU |
| R2 storage | 10 GB | Images + PDFs + sidecars; 90-day prune | OK |
| CPU | 10 ms | `PDF_EXTRACT_MODE=client` avoids CPU | OK; `worker` needs Paid |

Missing: per-token price table → no cost-aware routing or budget caps.

---

## 11. Persistence & Auth

**Persistence:** 6 migrations, typed `db/*`, `waitUntil` tap — solid. Gaps: `usage_ledger`, `provider_health`, `entitlements`, transactional session+message write (today: two statements, no `BEGIN`).

**Auth:** `jose` JWKS stateless, `AuthedContext` narrowed, suspension fresh, `ADMIN_EMAILS` promotion. Gaps: no refresh-token rotation, JWKS URL hardcoded to Google, no `kid` on signed file URLs.

---

## 12. Observability & UX

**Observability:** `observability.enabled: true` + `/api/health` booleans + `console.warn` on tool-loop cap. Gaps: no per-turn trace (route decision, attempts, latency, tokens), no provider histogram, no alert on crossover rate.

**UX:** React 19 streaming + `paced()` dedup, skeleton SVG fence, Composer gating on `vision`/`documents`, Sidebar search/rename, admin inspector. Gaps: live `Generated-File-JSON` not in bubble (P0), no optimistic session title, no offline resume.

---

---

## 14. Testing, Code Quality, Registry/Routing/Failover

**Testing:** 18 smoke/probe scripts cover happy paths + regressions (`smoke-sse-null-frame` for AgentRouter Claude, `smoke-tool-peek` for stream surgery). No unit suite, no CI, no D1 migration diff check, no load test. `oxlint` only.

**Code quality:** Comments are load-bearing (why, not what) — `FIREBASE_PROJECT_ID` public identifier note, `remote: true` neurons note, `viewBox` casing note all prevent future bugs. `intVar`/`listVar`/`resolvePolicy` single-call per request is tidy.

**Registry / Routing / Failover (the gap):** Today a 5-element constant + 4 regexes + same-gateway retry. The fix is not “smarter regex” but a registry table + ranked router + orchestrator with `crossable:true` and breaker. Sections 9 and 16 give the DDL, score, and contract.

---

## 15. Strategy — What to Chase, What to Keep

**Chase:** Model registry without deploy, ranked routing, cross-provider failover, usage ledger, provider health. These turn a good chat app into a platform.

**Keep:** Single Worker + D1/R2, JWKS auth, absolute-bucket limits, FigureGate+HTMLRewriter, Workers AI→Pollinations, `waitUntil` persistence. These are genuinely good and would be wasted if rewritten.

**Differentiation lives in SVG.** No other academic wrapper does symbolic diagrams safely. Double down: `id` namespacing, `<use>` same-doc scoping, figure export-audit.

---

## 16. Roadmap — Solo-Dev, Five Phases

> Each phase is a shippable increment. No phase rewrites what Phase 0 keeps.

### Phase 0 — Fix Now (this week, no migration)

| # | Title | Change | Files |
|---|-------|--------|-------|
| 0.1 | `UpstreamError extends ApiError` | `class UpstreamError extends ApiError { super(status,type,msg) }` → errors surface with `type`+`Retry-After` | `worker/provider.ts:97`, `worker/lib/http.ts` if needed |
| 0.2 | Wire live generated-file into bubble | `ChatApp.tsx:runTurn` `onMeta` → inject `meta.generatedFile` into streaming `Message.attachments` | `src/ChatApp.tsx`, `src/lib/api.ts` already parses |
| 0.3 | Timeout `crossable:true` | `AbortError`/timeout branch → `crossable:true` so orchestrator can retry | `worker/provider.ts` timeout |
| 0.4 | Vision guarantee | `routeAutoModel` `hasImages && !codeCraftAvailable →` return vision model or throw `NO_VISION_MESSAGE` with retry hint | `worker/models.ts`, `worker/routes/chat.ts` |

Verify each with `npm run build` + `wrangler dev` + existing `smoke-*`; commit separately.

### Phase 1 — Registry & Ledger (1–2 weeks)

- Migration `0007_model_definitions.sql` + `0008_usage_ledger.sql` + `0009_provider_health.sql`.
- Seed `model_definitions` from `MODELS` constant; `models.ts` reads D1 (cache per request).
- `usage_ledger` write in `sso` tap; admin spend query.
- Router still regex but reads registry (no hardcoded `findModel`).

### Phase 2 — Ranked Router + Adapter Seam (1–2 weeks)

- `ProviderAdapter` interface; split `provider.ts` → `adapters/*` + `orchestrator.ts`.
- Ranked router scoring `capability × price × health`.
- Add `price_in/out_per_1k` to registry; router trades cost for quality.

### Phase 3 — Failover Orchestrator + Health (1 week)

- `provider_health` rolling window + `disabled_until` breaker.
- Orchestrator cross-provider on `crossable:true`; per-turn trace log.
- `/api/health` exposes `provider_health` summary.

### Phase 4 — Entitlements & Admin (1–2 weeks)

- `entitlements` table; `resolvePolicy` per-user; admin plan UI.
- Registry CRUD in admin panel; no deploy to add a model.

### Phase 5 — Scale & Hardening (ongoing)

- Structured logs/traces per turn; latency histograms; alerts on crossover rate.
- Pre-signed R2 uploads; PDF sidecar user-prefix; `frame-ancestors` CSP.
- Resumable SSE cursor (nice-to-have, P3).

### What NOT to Build

- Second Worker or microservices (single Worker is the advantage).
- Custom auth service (Firebase + JWKS is correct for solo-dev).
- In-Worker PDF `unpdf` on Free plan (CPU ceiling makes `client` the right call; `worker` path is Paid-only).
- Vector search / RAG retrieval (not the product; PDF context chunking is enough).
- Billing provider integration (ledger first, billing later).



---

## 17. Provenance & Next Steps

- **Sources:** `worker/models.ts`, `worker/provider.ts`, `worker/routes/chat.ts`, `worker/index.ts`, `worker/env.ts`, `worker/sse.ts`, `worker/lib/{sanitizeSvg,figureGate,ratelimit,http}`, `worker/auth/middleware.ts`, `wrangler.jsonc`, `package.json`, `src/ChatApp.tsx`, `src/lib/api.ts`, `migrations/0001-0006`, `CODEBASE_REVIEW.md`, `DOCS.md` @ `bd646c5` on `enable-image-input`.
- **Archive:** `docs/archive/CODEBASE_REVIEW_bd646c5.md` (do not overwrite `PHASE2-*.md` until archived).
- **Verification:** Run `npm run build`, `npx tsc -b --noEmit`, `dir docs`, `dir docs\archive`, `git log --oneline -5`, `git status` after write; commit as `docs: architecture audit @ bd646c5 (enable-image-input)`.
- **Phase 0 fixes:** Separate commits `fix(provider): UpstreamError extends ApiError`, `fix(chat): wire Generated-File-JSON to live bubble`, `fix(provider): timeout crossable:true`, `fix(models): vision guarantee`.



## 13. SVG Deep Dive — Why It Works

1. **Prompt** invites ` ```svg` fence.
2. **FigureGate** (`lib/figureGate.ts`) withholds fence until ` ``` ` close, 64 kB or 30 s deadline → truncates + repairs `</svg>` + sanitises before emit. Skeleton ` ```svg\n` emitted immediately as placeholder.
3. **Sanitiser** (`sanitizeSvg.ts`) HTMLRewriter real parser; `ALLOWED_ELEMENTS`/`ALLOWED_ATTRS` lowercased deliberately (engine lowercases `tagName`); `element.remove()` drops subtree (not unwrap) — closes mXSS via `<foreignObject>`.
4. **Renderer** (`SvgFigure.tsx`) DOMPurify second pass + `id` namespacing (future) + pan/zoom/export.

Probe results: 10/10 parseable, 8/8 restraint (`gpt-5.6-sol`). Economics: Workers AI primary, Pollinations fallback keeps image feature alive past 10k neurons.


        WorkersAI[Workers AI<br/>flux-1-schnell]
        Pollinations[Pollinations<br/>flux fallback]
    end

    UI --> Composer --> ApiClient --> Router
    Composer -->|prepareImage + uploadFile| R2
    PdfWorker -.->|extracted text| ApiClient
    FirebaseSDK -->|ID token| AuthMid
    AuthMid --> Verify -.-> GoogleJWKS
    AuthMid --> RateLimit <--> D1
    Router --> ChatRoute --> Provider
    Provider -->|attempt 1..N keys| AgentRouter
    Provider -->|attempt 1..N keys| CodeCraft
    ChatRoute --> SSE --> FigGate --> ApiClient --> ChatArea --> SvgFigure
    ChatRoute -->|generate_image tool| ImageRoute --> WorkersAI -.->|quota failover| Pollinations --> R2 --> D1
    FileRoute <--> R2
    AdminRoute <--> D1
    ChatRoute -.->|waitUntil| D1
```

**Read the diagram as a trust boundary map:** Browser never talks to upstream; Worker never trusts Browser history (rebuilds from D1); every `/api/*` except `/api/health`, `/api/auth/session`, `/api/files/view` requires `AuthedContext`.

---

## 3. Ten-Dimension Scores

| # | Dimension | Score /10 | Rationale |
|---|-----------|-----------|-----------|
| 1 | **Architecture & Modularity** | **6.5** | Router table + `lib/*`/`db/*`/`routes/*` separation is clean; `AuthedContext` type-narrowing is senior. But `worker/models.ts` is a hardcoded constant and `provider.ts` is a single OpenAI-compatible client pretending to be two providers — no adapter seam. |
| 2 | **Multi-model / Capability** | **4.0** | 5 models + `auto` exist, but `routeAutoModel` is 4 regexes over raw text + env-key existence. No capability matrix, no cost/latency ranking, no vision→vision guarantee except “if hasImages return gemini” which still returns a non-vision gemini when CodeCraft is down. |
| 3 | **Reliability / Failover** | **5.5** | Stateless per-request key rotation + `UpstreamError.crossable` + image Workers AI→Pollinations works. Text has no cross-provider failover, no circuit breaker, no `provider_health`. A 502 from AgentRouter retries same gateway with next key, never jumps to CodeCraft. |
| 4 | **Security** | **7.5** | JWKS verification, `AuthedContext` enforcement, D1-rebuilt history (no forged assistant turns), `floor(now/period)` rate limits, dual-layer SVG sanitisation, HMAC file URLs, `ipHash` salt — all strong. See §8 for the 8 gaps. |
| 5 | **Persistence & Data** | **7.0** | 6 migrations, typed `db/*` helpers, `waitUntil` post-stream save (tokens never blocked by DB), R2 sidecars. Missing: `usage_ledger`, `provider_health`, `entitlements`, transactional session+message writes. |
| 6 | **Cost Control** | **5.0** | Per-user per-window rate limits + tool-image quarter-budget + Workers AI neuron math are good. No token metering, no per-model price table, no budget caps, no `usage_ledger` to attribute spend. |
| 7 | **Observability** | **4.5** | `wrangler.jsonc` `observability.enabled: true` + health readiness booleans + `console.warn` on tool-loop cap. No structured logs, no traces, no provider latency histograms, no alert on failover rate. |
| 8 | **UX & Frontend** | **7.5** | React 19 streaming with pacing (`paced()` in `api.ts`), skeleton SVG fence, Composer gating on `vision`/`documents`, Sidebar search/rename, Admin inspector — polished. Gap: `X-ChatDDB-Generated-File-JSON` is parsed in `streamChat` but live-bubble wiring is incomplete. |
| 9 | **SVG / Diagrams** | **9.0** | Differentiator. HTMLRewriter allowlist (lowercase-deliberate, subtree remove) + FigureGate (fence withholding, 64 kB + deadline, sanitise-before-emit) + DOMPurify second pass. Verified 10/10 parseable, 8/8 restraint on `gpt-5.6-sol` probe. Minor: no `id` namespacing across figures on same page. |
| 10 | **Testing & Ops** | **5.5** | 18 smoke/probe scripts + `smoke-sse-null-frame` regression + `prune.mjs`. No unit test suite, no CI, no `wrangler d1 migrations` diff check, no load test. |

**Average 6.2 → craftsmanship 7.4/10 after weighting security/SVG/Worker quality higher than routing gaps.**


`probe-vision/tool-calling/svg`, `test-provider`, `smoke-codecraft/auth/files/admin/images/image-failover/chat-image-tool/svg-sanitizer/figure-gate/tool-peek/sse-null`, `stub-pollinations`, `prune`, `cf-typegen`
