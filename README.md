# ChatDDB

ChatDDB is a React chat application deployed with a Cloudflare Worker. It uses
Firebase authentication, D1 for conversations and audit data, R2 for files, and
Cloudflare Workers AI with Pollinations fallback for image generation.

Text generation is managed by the dynamic AI routing architecture:

```text
browser service choice → ai_services → ai_routes (priority/failover) → api_providers → adapter → upstream model
```

The public client receives service names and capabilities only. Upstream model
IDs, provider credentials, routes, and health records remain server-side. The
default migration seeds ChatGPT, Gemini, Claude, DeepSeek, GLM, and Grok
services with AgentRouter and CodeCraft providers. Administrators can manage
services, providers, and routes through `/admin`.

## Setup

```bash
npm install
Copy-Item .dev.vars.example .dev.vars
npm run dev:all
```

Set `AGENTROUTER_API_KEY` and/or `CODECRAFT_API_KEY` in `.dev.vars`. These
secrets may also be stored with `npm run secret:agentrouter` and
`npm run secret:codecraft`. Apply D1 migrations before using a new deployment:

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
npm run smoke:svg-sanitizer
npm run smoke:figure-gate
npm run smoke:sse-null
```

Some integration smoke tests require a local Worker, Firebase token, or live
provider credentials. See [DOCS.md](DOCS.md) for the full command list and
operations reference.
