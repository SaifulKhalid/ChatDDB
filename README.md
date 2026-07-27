# PrototypeChatBot

A ChatGPT-style chatbot running on **Cloudflare Workers**, powered by multiple AI providers (**AgentRouter** for ChatGPT & Claude, **Groq** for Llama, and **Google Gemini**). Supports image and PDF uploads, streaming responses, conversation history, and a clean ChatGPT-like UI.

## Features

- 🤖 **Multiple AI providers** — switch between ChatGPT, Claude, Gemini, and Llama on the fly
- 🏷️ **Friendly model labels** — clients see brand names (ChatGPT, Claude, Gemini), not internal model IDs
- 📸 **Image uploads** — vision-capable models can analyze images
- 📄 **PDF uploads** — text is extracted and provided as context to the model
- ⚡ **Streaming responses** — real-time token streaming via Server-Sent Events (SSE)
- 💬 **Conversation history** — persisted in Cloudflare D1 (SQLite)
- 🗄️ **File storage** — uploads stored in Cloudflare R2
- 🎨 **Premium Next.js UI** — dark/light/system themes, sidebar, markdown rendering, drag-and-drop, animations
- 🛑 **Stop generation** — abort streaming mid-response
- 📋 **Paste images** — paste from clipboard directly into the composer

## Architecture

```
Browser (Next.js SPA — web/out/)
  ↕ fetch / SSE
Cloudflare Worker (src/index.ts)
  • REST API (/api/*)
  • SSE streaming (/api/chat)
  • Static asset serving (ASSETS binding → web/out/)
D1 (DB)         R2 (BUCKET)       AI Providers
conversations    uploads/          • AgentRouter (ChatGPT, Claude, Kimi)
messages                           • Groq (Llama)
                                   • Gemini
                                   • Workers AI (Mistral, Llama, Gemma)
                                   • OpenRouter (free models)
```

## Available Models

| Label | Provider | Vision | Model ID |
|---|---|---|---|
| Groq | Groq | ❌ | llama-3.1-8b-instant |
| Gemini | Gemini | ✅ | gemini-2.5-flash |
| Kimi | AgentRouter | ✅ | kimi-k3 |
| Claude | AgentRouter | ✅ | claude-opus-4-8 |
| ChatGPT | AgentRouter | ✅ | gpt-5.6-sol |
| Workers AI (Mistral 7B) | Workers AI | ❌ | @cf/mistral/mistral-7b-instruct-v0.3 |
| Workers AI (Vision) | Workers AI | ✅ | @cf/meta/llama-3.2-11b-vision-instruct |
| Workers AI (Llama 3.3) | Workers AI | ❌ | @cf/meta/llama-3.3-70b-instruct-fp8-fast |
| Workers AI (Gemma 2 27B) | Workers AI | ❌ | @hf/google/gemma-2-27b-it |
| Laguna S 2.1 | OpenRouter | ❌ | poolside/laguna-s-2.1:free |
| OpenRouter Free | OpenRouter | ❌ | openrouter/free |
| Ling 3.0 Flash | OpenRouter | ❌ | inclusionai/ling-3.0-flash:free |
| GPT-OSS 20B | OpenRouter | ❌ | openai/gpt-oss-20b:free |
| Gemma 4 26B | OpenRouter | ❌ | google/gemma-4-26b-a4b-it:free |

## Prerequisites

- Node.js 18+
- A Cloudflare account
- API keys for AgentRouter (https://agentrouter.org/), Groq (https://console.groq.com/keys), and Gemini (https://aistudio.google.com/apikey)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create Cloudflare resources

```bash
npx wrangler d1 create prototype-chatbot-db
npx wrangler r2 bucket create prototype-chatbot-bucket
```

Copy the database_id from the D1 output into wrangler.jsonc.

### 3. Initialize the database

```bash
npm run db:init          # local
npm run db:init:remote   # remote (production)
```

### 4. Set API keys

For local development, copy .dev.vars.example to .dev.vars and fill in your keys.

For production:
```bash
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put AGENTROUTER_API_KEY
```

### 5. Run locally

```bash
npm run dev
```

Open http://localhost:8787 in your browser.

### 6. Deploy

```bash
npm run deploy
```

### 7. Warm up (prevent cold starts)

Cloudflare Workers idle after a few seconds of inactivity, causing a cold
start on the next request. Run the warmup script periodically to keep the
worker responsive:

```bash
# Single run:
npm run warmup https://your-worker.workers.dev

# Or via environment variable:
WORKER_URL=https://your-worker.workers.dev npm run warmup
```

**Cron setup (every 5 minutes):**

```bash
# Edit your crontab:
crontab -e

# Add this line (update the path and worker URL):
*/5 * * * * cd /path/to/prototype-chatbot && WORKER_URL=https://your-worker.workers.dev node scripts/warmup.mjs >> /tmp/warmup.log 2>&1
```

The script pings `/api/health`, `/api/models`, and `/` with a 10-second
timeout per endpoint, logs latency, and exits non-zero if all requests fail
(useful for monitoring).

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| GET | /api/health | Health check |
| GET | /api/models | List available models |
| GET | /api/conversations | List all conversations |
| POST | /api/conversations | Create a conversation |
| GET | /api/conversations/:id | Get conversation + messages |
| PATCH | /api/conversations/:id | Update title or model |
| DELETE | /api/conversations/:id | Delete conversation |
| POST | /api/upload | Upload file to R2 (multipart form, field file) |
| GET | /api/files/:key | Serve file from R2 |
| POST | /api/chat | Stream chat completion (SSE) |

### Chat request body

```json
{
  "conversationId": "uuid",
  "message": "Hello!",
  "attachments": [],
  "model": "agentrouter:gpt-5.5"
}
```

## Configuration

Secrets (set via wrangler secret put or .dev.vars):

| Secret | Description |
|---|---|
| GROQ_API_KEY | Groq API key |
| GEMINI_API_KEY | Google Gemini API key |
| AGENTROUTER_API_KEY | AgentRouter API key (for ChatGPT & Claude) |
| OPENROUTER_API_KEY | OpenRouter API key (for free chat & image generation) |

## Adding More Models

Edit src/types.ts and add entries to the MODELS array. The provider routing in src/providers.ts handles the rest automatically.

## Tech Stack

- Runtime: Cloudflare Workers
- Database: Cloudflare D1 (SQLite)
- Storage: Cloudflare R2
- AI: AgentRouter (OpenAI-compatible: ChatGPT, Claude, Kimi), Groq API (Llama), Google Gemini API, Workers AI (Cloudflare edge inference), OpenRouter (free models)
- PDF: unpdf (Workers-compatible PDF text extraction)
- Frontend: Next.js 15 + React 19 + Tailwind CSS + Framer Motion

## License

MIT