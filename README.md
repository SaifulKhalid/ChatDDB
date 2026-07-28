# ChatDDB — One Workspace. Every AI.

A production-grade AI workspace that brings together **Groq, OpenAI (ChatGPT), Anthropic (Claude), Google Gemini, Cloudflare Workers AI, and OpenRouter** — all in one beautiful, unified chat interface.

**Live deployments:**
- **Cloudflare Workers:** https://prototype-chatbot.chatddb-smoke.workers.dev
- **Vercel:** https://chatddb.vercel.app

---

## Features

- 🤖 **10+ AI models** — Switch between Groq, ChatGPT, Claude, Gemini, Workers AI, and OpenRouter
- ✨ **Auto Mode** — Intelligently selects the best model for your task (prioritizes Groq → ChatGPT → others)
- ⚡ **Real-time streaming** — See responses as they're generated (SSE)
- 💬 **Conversation history** — Persisted via Cloudflare D1 (SQLite)
- 📸 **Image upload & analysis** — Vision-capable models can analyze your images
- 📄 **PDF upload & analysis** — Text extraction + chunking for context
- 🎨 **Image generation** — Generate images via FLUX.1 Schnell and Leonardo Lucid
- 🔑 **Firebase Authentication** — Google sign-in + email/password
- 👤 **Guest mode** — Try before you sign up (limited quota)
- 🛡️ **Admin panel** — Model CRUD, user management, email allowlist
- 🌗 **Dark/Light/System themes** — Smooth theme switching
- 🛑 **Stop generation** — Abort streaming mid-response
- 📋 **Clipboard paste** — Paste images directly into the composer

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Browser (Next.js SPA)               │
│  Vercel (https://chatddb.vercel.app)                 │
│  or Workers (https://...workers.dev)                  │
└──────────────────────┬──────────────────────────────┘
                       │ fetch / SSE
┌──────────────────────▼──────────────────────────────┐
│           Cloudflare Worker (src/index.ts)           │
│  • REST API (/api/*)                                 │
│  • SSE streaming (/api/chat)                         │
│  • Static asset serving (ASSETS → web/out/)          │
└──┬──────────────┬──────────────┬─────────────────────┘
   │              │              │
┌──▼──┐     ┌────▼────┐    ┌────▼──────────────┐
│ D1  │     │   R2    │    │   AI Providers     │
│ DB  │     │ Bucket  │    │ • Groq             │
│     │     │         │    │ • AgentRouter      │
│     │     │ Uploads │    │   (ChatGPT, Claude)│
│     │     │ Files   │    │ • Gemini           │
│     │     │ Meta    │    │ • Workers AI       │
│     │     │         │    │ • OpenRouter       │
└─────┘     └─────────┘    └────────────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js 15 + React 19 + Tailwind CSS + Framer Motion |
| **Backend** | Cloudflare Workers (TypeScript) |
| **Database** | Cloudflare D1 (SQLite-compatible) |
| **File Storage** | Cloudflare R2 |
| **Auth** | Firebase Authentication (Google + Email/Password) |
| **AI Providers** | Groq, AgentRouter (ChatGPT, Claude), Gemini, Workers AI, OpenRouter |
| **Deployment** | Cloudflare Workers + Vercel |

## Prerequisites

- Node.js 18+
- A [Cloudflare](https://dash.cloudflare.com/) account
- A [Firebase](https://console.firebase.google.com/) project (with Auth enabled)
- API keys for desired AI providers:
  - [Groq](https://console.groq.com/keys)
  - [AgentRouter](https://agentrouter.org/) (for ChatGPT & Claude)
  - [Gemini](https://aistudio.google.com/apikey)
  - [OpenRouter](https://openrouter.ai/keys) (optional, for free models)

## Setup

### 1. Install dependencies

```bash
npm install
cd web && npm install && cd ..
```

### 2. Create Cloudflare resources

```bash
npx wrangler d1 create prototype-chatbot-db
npx wrangler r2 bucket create prototype-chatbot-bucket
```

Copy the `database_id` from the D1 output into `wrangler.jsonc`.

### 3. Initialize the database

```bash
# Local development
npm run db:init

# Production (remote)
npm run db:init:remote
```

### 4. Configure Firebase

Create a Firebase project at https://console.firebase.google.com, enable Authentication (Google + Email/Password), and create a web app. Copy the Firebase config into `web/.env.local`:

```
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
```

### 5. Set API keys

**Local development** — copy `.dev.vars.example` to `.dev.vars`:

```
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=AIza...
AGENTROUTER_API_KEY=ar_...
OPENROUTER_API_KEY=sk-or-...
```

**Production:**

```bash
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put AGENTROUTER_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
```

### 6. Run locally

```bash
npm run dev
```

Open http://localhost:8787 in your browser.

### 7. Build frontend

```bash
cd web && npm run build && cd ..
```

### 8. Deploy

```bash
# Deploy to Cloudflare Workers
npm run deploy

# Deploy frontend to Vercel
cd web && NEXT_PUBLIC_API_URL=https://your-worker.workers.dev npx vercel --prod
```

## Auto Model Selection

When **Auto** mode is active, ChatDDB intelligently selects the best model based on your request:

| Priority | Provider | Best For |
|----------|----------|----------|
| 1 🥇 | **Groq** | Fast responses, simple chat, coding |
| 2 🥈 | **AgentRouter** (ChatGPT/Claude) | Complex reasoning, creative tasks, premium quality |
| 3 🥉 | **Workers AI** | Vision tasks, image analysis |
| 4 | **Gemini** | Long context, PDF analysis, math |
| 5 | **OpenRouter** | Free fallback |

The selector analyzes your message for patterns (code, reasoning, math, translation, etc.) and routes to the best provider. If a provider fails, it automatically falls back to the next best option.

## API Reference

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/health` | No | Health check |
| GET | `/api/models` | No | List available models |
| GET | `/api/conversations` | Yes | List conversations |
| POST | `/api/conversations` | Yes | Create conversation |
| GET | `/api/conversations/:id` | Yes | Get conversation + messages |
| PATCH | `/api/conversations/:id` | Yes | Update title/model |
| DELETE | `/api/conversations/:id` | Yes | Delete conversation |
| POST | `/api/upload` | Yes | Upload file (multipart) |
| GET | `/api/files/:key` | No | Serve uploaded file |
| POST | `/api/chat` | Yes | Stream chat (SSE) |
| POST | `/api/auth/login` | No | Verify Firebase token |
| GET | `/api/auth/me` | No | Get current user |
| POST | `/api/enhance` | Yes | Enhance prompt |
| POST | `/api/generate-image` | Yes | Generate image |

### Chat SSE Event Format

```
data: {"type":"start","messageId":"uuid"}

data: {"type":"delta","text":"Hello"}

data: {"type":"model_selection","model":"groq:llama-3.1-8b-instant","label":"llama-3.1-8b-instant","reason":"Chat request · Best value"}

data: {"type":"done","text":"Hello! How can I help you?"}

data: {"type":"error","error":"Service unavailable"}
```

## Configuration

### Environment Variables (Cloudflare Worker)

| Variable | Type | Description |
|----------|------|-------------|
| `APP_NAME` | Var | Application name |
| `MAX_UPLOAD_BYTES` | Var | Max file upload size (default: 20MB) |
| `RATE_LIMIT_MAX` | Var | Max requests per window (default: 60) |
| `RATE_LIMIT_WINDOW` | Var | Rate limit window in seconds (default: 60) |
| `GUEST_MAX_MESSAGES` | Var | Guest message quota (default: 10) |
| `GUEST_MAX_UPLOADS` | Var | Guest upload quota (default: 2) |
| `GUEST_MAX_IMAGE_GENS` | Var | Guest image gen quota (default: 2) |
| `GROQ_API_KEY` | Secret | Groq API key |
| `GEMINI_API_KEY` | Secret | Google Gemini API key |
| `AGENTROUTER_API_KEY` | Secret | AgentRouter API key |
| `OPENROUTER_API_KEY` | Secret | OpenRouter API key |

## Adding Models

### Via Admin Panel (Recommended)

1. Sign in with an admin email
2. Go to **Settings → Admin Panel**
3. Click **Add Model** and fill in the details

### Via Code

Edit `src/types.ts` — add entries to the `MODELS` array. Provider routing in `src/providers.ts` handles the rest automatically.

## Development

```bash
# TypeScript type-checking
npm run typecheck
cd web && npm run typecheck

# Watch mode (worker)
npm run dev

# Watch mode (frontend)
cd web && npm run dev

# Database management
npm run db:init        # Local
npm run db:init:remote # Remote
npm run db:reset       # Local (destructive)
```

## Warmup (Prevent Cold Starts)

Cloudflare Workers idle after a few seconds of inactivity. Run the warmup script periodically:

```bash
npm run warmup https://your-worker.workers.dev
```

**Cron (every 5 minutes):**
```bash
*/5 * * * * cd /path/to/chatddb && WORKER_URL=https://your-worker.workers.dev node scripts/warmup.mjs >> /tmp/warmup.log 2>&1
```

## License

MIT
