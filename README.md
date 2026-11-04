# ChatDDB

ChatDDB is a React chat application deployed with a Cloudflare Worker. It uses
Firebase authentication, D1 for conversations and audit data, R2 for files, and
Cloudflare Workers AI with Pollinations fallback for image generation.

Text generation is managed by a high-performance two-provider architecture:

```text
browser request → static catalogue (worker/catalog.ts) → priority ladder (AgentRouter / ApiNex) → upstream model
```

The system supports exactly two upstream providers:
1. **AgentRouter**: Base `https://agentrouter.org/v1` via OpenAI Responses API (`/v1/responses`), with mandatory `codex_cli_rs/0.40.0` client User-Agent.
2. **ApiNex**: Base `https://api.apinex.bond/v1` via standard OpenAI Chat Completions API (`/v1/chat/completions`).

The public client receives clean model names and capability flags only (`/api/ai-services` and `/api/models` served with `Cache-Control: public, max-age=300`). Upstream model IDs, provider keys, and failure metrics remain server-side. Zero D1 database reads occur during model resolution or route selection. An in-memory circuit breaker per Worker isolate trips for 60 seconds after 3 consecutive failures and recovers automatically.

## Setup

```bash
npm install
Copy-Item .dev.vars.example .dev.vars
npm run dev:all
```

Set `AGENTROUTER_API_KEY` and/or `APINEX_API_KEY` in `.dev.vars` (or pass via environment variables). Additional rotated keys may be configured via `_2` and `_3` suffixes (`AGENTROUTER_API_KEY_2`, `APINEX_API_KEY_2`). Secrets can also be provisioned with `npm run secret:agentrouter` and `npm run secret:apinex`. Apply D1 migrations before using a new deployment:

```bash
npm run db:migrate
npm run deploy
```

The deployed Worker, D1 database, and R2 bucket use the `chatddb-f5` name.

## Guest Mode

ChatDDB includes a complete "Continue as guest" experience powered by Firebase Anonymous Auth:
- **Full Access**: Guests can use all features (chat turns, models, file uploads, image generation, session history) without signing in with Google.
- **Identity & Quotas**: Guest users are registered in D1 with `is_guest = 1`, a synthetic email (`guest-<id>@guest.invalid`), and tier-adjusted daily quotas.
- **Admin Visibility**: Guests appear in the admin user list with a Guest badge, full session transcripts, files, and activity logs. Suspending or reactivating guest accounts works identically to regular users.
- **Account Upgrade & Merge**: Guests can upgrade anytime via "Sign in to save" (`linkWithPopup`). If the Google account is already registered, `/api/auth/merge-guest` atomically reassigns all guest sessions, messages, and files to the existing user in one D1 batch.
- **Scheduled Retention**: A Cloudflare cron trigger (`0 3 * * *`) cleans up inactive guests older than `GUEST_RETENTION_DAYS` (default 30 days), deleting their R2 assets and cascading DB records while preserving activity logs.

## Validation

```bash
npm run build
npm run lint
npm run test:provider
npm run test:orchestration
npm run smoke:guest
npm run smoke:failover
npm run smoke:svg-sanitizer
npm run smoke:figure-gate
npm run smoke:sse-null
```

Some integration smoke tests require a local Worker, Firebase token, or live
provider credentials. See [DOCS.md](DOCS.md) for the full command list and
operations reference.
