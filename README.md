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

## Validation

```bash
npm run build
npm run lint
npm run test:provider
npm run test:orchestration
npm run smoke:failover
npm run smoke:svg-sanitizer
npm run smoke:figure-gate
npm run smoke:sse-null
```

Some integration smoke tests require a local Worker, Firebase token, or live
provider credentials. See [DOCS.md](DOCS.md) for the full command list and
operations reference.
