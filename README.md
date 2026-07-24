# PrototypeChatBot

A ChatGPT-style chatbot running on **Cloudflare Workers**, powered by multiple AI providers (**AgentRouter** for ChatGPT & Claude, **Groq** for Llama, and **Google Gemini**). Supports image and PDF uploads, streaming responses, conversation history, and a clean ChatGPT-like UI. **Model names are hidden** — clients see only friendly brand labels like "ChatGPT", "Claude", "Gemini", etc.

## Features

- 🤖 **Multiple AI providers** — switch between ChatGPT, Claude, Gemini, and Llama on the fly
- 🏷️ **Friendly model labels** — clients see brand names (ChatGPT, Claude, Gemini), not internal model IDs
- 📸 **Image uploads** — vision-capable models can analyze images
- 📄 **PDF uploads** — text is extracted and provided as context to the model
- ⚡ **Streaming responses** — real-time token streaming via Server-Sent Events (SSE)
- 💬 **Conversation history** — persisted in Cloudflare D1 (SQLite)
- 🗄️ **File storage** — uploads stored in Cloudflare R2
- 🎨 **ChatGPT-like UI** — dark theme, sidebar, markdown rendering, drag-and-drop
- 🛑 **Stop generation** — abort streaming mid-response
- 📋 **Paste images** — paste from clipboard directly into the composer

## Architecture

```
Browser (public/index.html, styles.css, app.js)
  ↕ fetch / SSE
Cloudflare Worker (src/index.ts)
  • REST API (/api/*)
  • SSE streaming (/api/chat)
  • Static asset serving (ASSETS binding)
D1 (DB)         R2 (BUCKET)       AI Providers
conversations    uploads/          • AgentRouter (GPT/Claude)
messages                           • Groq (Llama models)
                                   • Gemini
```

## Available Models

Clients see only the **Label** — internal model IDs are never exposed to the UI.

| Label | Provider | Vision | Internal Model |
|---|---|---|---|
| ChatGPT | AgentRouter | ✅ | gpt-5.5 |
| Claude | AgentRouter | ✅ | claude-opus-4-6 |
| Gemini | Gemini | ✅ | gemini-2.0-flash |
| Gemini Pro | Gemini | ✅ | gemini-2.5-flash |
| Llama | Groq | ❌ | llama-3.3-70b-versatile |
| Llama Fast | Groq | ❌ | llama-3.1-8b-instant |
| Llama Vision | Groq | ✅ | llama-4-scout-17b |

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

## Adding More Models

Edit src/types.ts and add entries to the MODELS array. The provider routing in src/providers.ts handles the rest automatically.

## Tech Stack

- Runtime: Cloudflare Workers
- Database: Cloudflare D1 (SQLite)
- Storage: Cloudflare R2
- AI: AgentRouter (OpenAI-compatible, ChatGPT & Claude), Groq API (Llama), Google Gemini API
- PDF: unpdf (Workers-compatible PDF text extraction)
- Frontend: Vanilla HTML/CSS/JS (no build step)

## License

MIT