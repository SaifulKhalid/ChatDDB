# ChatDDB operations reference

## Architecture

The React SPA and API deploy together as the `chatddb-f5` Cloudflare Worker.
`/api/*` requests run in the Worker; static assets come from `dist/`. Firebase
ID tokens are verified in the Worker. D1 stores users, sessions, messages,
files, rate counters, and audit activity. R2 stores uploaded files, extracted text, and generated images.

Text requests use a streamlined, zero-D1 static catalogue routing path:

1. `POST /api/chat` resolves the public AI model statically from `worker/catalog.ts`
   (zero database queries).
2. Rate-limiting check, session verification/creation, history read, and preloaded
   attachment checks run concurrently via `Promise.all` in a single parallel step.
3. `worker/routing.ts` selects eligible targets for the model across the two supported
   providers (**AgentRouter** and **ApiNex**), observing per-isolate in-memory
   circuit breakers (trips for 60s after 3 consecutive failures).
4. `callUpstream()` executes the request against the provider using its configured
   wire protocol (`/v1/responses` for AgentRouter, `/v1/chat/completions` for ApiNex),
   enforcing separate TTFB timeouts (default 20s) and total timeouts (default 180s),
   with multi-key rotation and last-good key memory.
5. If the primary target fails prior to sending the first byte, the router fails
   over silently to the next target. If a failure occurs post-first-byte, it is
   emitted as a stream error frame without corrupting or restarting the client response.
6. `worker/sse.ts` normalises upstream SSE, handles tool-call lookahead, and
   passes all SVG fences through `FigureGate` before streaming or persistence.

`GET /api/ai-services` and `GET /api/models` are served directly from the static
catalogue with `Cache-Control: public, max-age=300` (zero D1 queries). Admin health
is monitored via `GET /api/admin/provider-health`.

## Configuration

Non-secret operational settings are in `wrangler.jsonc`; secrets belong in
`.dev.vars` locally or Cloudflare Worker secrets in production.

| Secret | Purpose |
| --- | --- |
| `AGENTROUTER_API_KEY`, `_2`, `_3` | Credentials for AgentRouter (`https://agentrouter.org/v1`); rotated on 401/429. |
| `APINEX_API_KEY`, `_2`, `_3` | Credentials for ApiNex (`https://api.apinex.bond/v1`); rotated on 401/429. |
| `UPSTREAM_TTFB_TIMEOUT_MS` | Optional time-to-first-byte timeout in ms (default 20,000). |
| `POLLINATIONS_API_KEY` | Optional fallback image provider credential. |
| `FILE_URL_SECRET` | Signs short-lived file-view URLs. |
| `IP_HASH_SALT` | Salts IP hashes written to audit data. |

AI provider base URLs, headers, models, priority, capabilities, and completion
configuration are private database records seeded by migration `0007`. Change
them through the admin interface or its protected API; do not add a parallel
environment-variable model registry.

Other Worker variables control Firebase identity, PDF limits, attachment limits,
image generation, SVG prompting, CORS, and rate limits. `POLLINATIONS_ENABLED`
and `SVG_DIAGRAMS` are disabled only by the literal value `false`.

### Guest mode policy and retention variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `RATE_GUEST_CREATE_PER_DAY` | `15` | Max guest accounts created per IP per day. |
| `RATE_GUEST_CREATE_PER_MIN` | `5` | Max guest accounts created per IP per minute. |
| `RATE_GUEST_CHAT_PER_DAY` | `50` | Daily chat turn budget for guest tier. |
| `RATE_GUEST_UPLOAD_PER_DAY` | `20` | Daily upload budget for guest tier. |
| `RATE_GUEST_IMAGE_PER_DAY` | `5` | Daily button image generation budget for guest tier. |
| `RATE_GUEST_TOOL_IMAGE_PER_DAY` | `2` | Daily tool image generation budget for guest tier. |
| `MAX_GUEST_IMAGE_BYTES` | `10485760` (10 MB) | Max file size for guest image uploads. |
| `MAX_GUEST_PDF_BYTES` | `15728640` (15 MB) | Max file size for guest PDF uploads. |
| `GUEST_RETENTION_DAYS` | `30` | Inactivity threshold before scheduled cleanup purges guest assets and accounts. |

### Scheduled retention cron

Cloudflare Workers cron trigger (`triggers.crons: ["0 3 * * *"]`) runs daily at 03:00 UTC:
- Invokes `cleanupExpiredGuests` (`worker/cron/cleanup.ts`).
- Finds guest accounts (`is_guest = 1`) whose last login or creation date is older than `GUEST_RETENTION_DAYS`.
- Deletes their R2 stored objects (`r2_key` and `extracted_text_key`).
- Deletes the guest user row in D1, cascading to remove sessions, messages, and files.
- Preserves audit logs (`activity_logs.user_id` set to `NULL` via `ON DELETE SET NULL`).

## Security and data paths

- Authentication and administrator authorization are enforced in the Worker.
- Guest mode uses Firebase Anonymous Auth (`is_guest = 1`, synthetic `guest-<id>@guest.invalid`). Guests are immune to `ADMIN_EMAILS` matching, never reconcile registered email accounts, and receive 403 `admin_required` (logged as `suspicious_activity`) on `/api/admin/*`.
- Guests upgrade in-place via `linkWithPopup`. If the Google account is already registered, `POST /api/auth/merge-guest` atomically reassigns all sessions, messages, and files in one D1 batch and deletes the guest row.
- Chat history is rebuilt server-side; clients cannot submit an assistant
  transcript.
- Uploads are checked for ownership and file type before use.
- Signed file URLs use HMACs; D1 and R2 remain private bindings.
- Rate limits apply to chat, uploads, authentication, administration, images,
  and model-triggered images.
- SVG is sanitized twice: an HTMLRewriter allowlist in the Worker and DOMPurify
  in the browser. The stream gate prevents incomplete or unsafe SVG from being
  persisted or rendered.

## Common commands

| Command | Purpose |
| --- | --- |
| `npm run dev:all` | Vite and Worker development servers. |
| `npm run build` | Type-check all TypeScript projects and build the SPA. |
| `npm run lint` | Run Oxlint. |
| `npm run deploy` | Build and deploy the `chatddb-f5` Worker. |
| `npm run db:migrate` | Apply remote D1 migrations. |
| `npm run db:migrate:local` | Apply local D1 migrations. |
| `npm run test:provider` | No-network tests for the active provider adapter. |
| `npm run test:orchestration` | Routing, health, credential masking, and error-boundary tests. |
| `npm run smoke:guest` | End-to-end guest mode verification (auth, chat, refresh, caps, IP limits, admin view, upgrade, merge). |
| `npm run smoke:svg-sanitizer` | Worker SVG sanitizer tests. |
| `npm run smoke:figure-gate` | Streaming SVG gate tests. |
| `npm run smoke:sse-null` | SSE null-frame regression test. |
| `npm run smoke:failover` | Stub upstream failover & SSE resilience test (TTFB timeout, 429, 502, null frames, mid-stream drops). |
| `npm run smoke:ai-routing` | Live/public-boundary routing smoke test (requires a Worker; admin cases need a token). |
| `npm run smoke:files` | File/R2 smoke test (requires an authenticated local deployment). |
| `npm run smoke:images` | Workers AI image-generation smoke test. |
| `npm run smoke:image-failover` | Image fallback smoke test. |
| `npm run smoke:chat-image-tool` | In-chat image tool smoke test. |

`probe:*` commands spend provider capacity and are diagnostic probes, not normal
CI checks. Historical planning and point-in-time audit documents were removed
during repository cleanup; Git history retains them when needed for forensics.
