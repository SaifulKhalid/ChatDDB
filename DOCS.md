# ChatDDB operations reference

## Architecture

The React SPA and API deploy together as the `chatddb-f5` Cloudflare Worker.
`/api/*` requests run in the Worker; static assets come from `dist/`. Firebase
ID tokens are verified in the Worker. D1 stores users, sessions, messages,
files, rate counters, activity, AI services, providers, routes, and route
health. R2 stores uploaded files, extracted text, and generated images.

Text requests use the database-backed routing path:

1. `POST /api/chat` rebuilds the user's history from D1 and resolves the
   requested public service (or automatically selects a live service).
2. `worker/orchestrator.ts` filters enabled routes by required capabilities,
   orders them by priority and weight, observes circuit breakers, and fails over
   before the response stream starts.
3. The selected provider is executed through `worker/adapters/openai.ts`.
   The adapter applies provider headers, route-specific completion options,
   timeout handling, and key rotation. It never exposes internal identifiers to
   the client.
4. `worker/sse.ts` normalises upstream SSE, handles tool-call lookahead, and
   passes all SVG fences through `FigureGate` before streaming or persistence.

`GET /api/ai-services` is the canonical public discovery endpoint. `GET
/api/models` remains only as a compatibility response with the same safe public
service data. Admin routes under `/api/admin/ai-*` manage the private routing
records.

## Configuration

Non-secret operational settings are in `wrangler.jsonc`; secrets belong in
`.dev.vars` locally or Cloudflare Worker secrets in production.

| Secret | Purpose |
| --- | --- |
| `AGENTROUTER_API_KEY`, `_2`, `_3` | Credentials for routes using the AgentRouter provider; keys are rotated on eligible failures. |
| `CODECRAFT_API_KEY` | Credential for CodeCraft routes. |
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

## Security and data paths

- Authentication and administrator authorization are enforced in the Worker.
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
| `npm run smoke:svg-sanitizer` | Worker SVG sanitizer tests. |
| `npm run smoke:figure-gate` | Streaming SVG gate tests. |
| `npm run smoke:sse-null` | SSE null-frame regression test. |
| `npm run smoke:ai-routing` | Live/public-boundary routing smoke test (requires a Worker; admin cases need a token). |
| `npm run smoke:files` | File/R2 smoke test (requires an authenticated local deployment). |
| `npm run smoke:images` | Workers AI image-generation smoke test. |
| `npm run smoke:image-failover` | Image fallback smoke test. |
| `npm run smoke:chat-image-tool` | In-chat image tool smoke test. |

`probe:*` commands spend provider capacity and are diagnostic probes, not normal
CI checks. Historical planning and point-in-time audit documents were removed
during repository cleanup; Git history retains them when needed for forensics.
