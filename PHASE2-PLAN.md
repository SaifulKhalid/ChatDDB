# ChatDDB — Phase 2 Architecture Plan

**Scope:** authentication, persistent storage, file uploads, activity logging, and
an admin monitoring panel.

**Status:** plan only. No implementation has started.

Decisions locked with you before writing this:

| Decision | Choice |
| --- | --- |
| Auth gate | **Login required to chat.** Mock mode survives only for local dev with no key. |
| Models | **`gpt-5.6-sol` only for now.** Capability registry + per-message model logging built so adding models later is config-only. |
| PDF extraction | **Server-side in the Worker via unpdf** is the target architecture. See [§9.2](#92-the-free-plan-blocks-worker-side-pdf-parsing) — it cannot run on the Free plan, so it ships behind a flag. |
| Cloudflare plan | **Workers Free.** Every design choice below respects its ceilings. |

- [1. Current architecture](#1-current-architecture)
- [2. What changes, and what must not](#2-what-changes-and-what-must-not)
- [3. Data model](#3-data-model)
- [4. Backend design](#4-backend-design)
- [5. Frontend design](#5-frontend-design)
- [6. File upload pipeline](#6-file-upload-pipeline)
- [7. Security model](#7-security-model)
- [8. Privacy and audit](#8-privacy-and-audit)
- [9. Free-plan constraints](#9-free-plan-constraints)
- [10. File-by-file change list](#10-file-by-file-change-list)
- [11. Implementation phases](#11-implementation-phases)
- [12. Environment variables](#12-environment-variables)
- [13. Operational commands](#13-operational-commands)
- [14. Open questions and risks](#14-open-questions-and-risks)

---

## 1. Current architecture

### 1.1 What exists today

One Cloudflare Worker (`chatddb-f5`) serves both the API and the built SPA.
`run_worker_first: ["/api/*"]` forces API paths to the Worker; everything else is
static assets with SPA fallback.

```
Browser (React 19 SPA)          Worker                    AgentRouter
  App.tsx  ─ state              index.ts   ─ routes         gpt-5.6-sol
  lib/api.ts ─ SSE reader  ───▶ agentrouter.ts ─ client ──▶
  lib/storage.ts ─ localStorage sse.ts    ─ normaliser
```

Three endpoints exist: `POST /api/chat` (SSE), `GET /api/health`,
`GET /api/models`. There is no database, no bucket, no auth, and no server-side
state of any kind.

### 1.2 Properties that constrain the design

| Property | Consequence for Phase 2 |
| --- | --- |
| **No auth at all.** No users, sessions, cookies, or tokens. | Nothing to stay compatible with — auth is greenfield. The "maintain compatibility with current authentication flow" requirement is vacuous here, which removes a whole class of migration risk. |
| **History lives in `localStorage`** under `chatddb.conversations`, debounced 400 ms, keyed per browser. | D1 replaces it. Existing users have real chats in their browser → a one-time import path is needed (§5.4). |
| **The client posts the full message history** on every turn: `{messages: [...]}`. The Worker validates but trusts it. | Once messages are in D1 the server should rebuild history itself. This is a security upgrade (a client can no longer forge assistant turns or inject another user's text) but it is a **breaking change to the request body**. The SSE *response* contract does not change. |
| **The SSE response contract is load-bearing.** `paced()`, the error-frame path, and four smoke tests all depend on the exact frame shape. | Frozen. Every phase must keep `data: {"choices":[{"delta":{"content":…}}]}` / `data: [DONE]` byte-identical. `smoke-backend.mjs` is the regression gate. |
| **`streamChat` treats 404/502/503 as "no backend"** and silently streams a mock reply. | New auth failures must never use those codes, or a 401 would look like a working demo. 401/403 must surface as real errors. |
| **`messages` is the only request field; roles are `user`/`assistant`** in the frontend type, plus `system` in the Worker. | Attachments need a new field, and `Message` gains an attachments array. |
| **Worker has no `ExecutionContext` in its handler signature** (`fetch(request, env)`). | Post-stream persistence needs `ctx.waitUntil`, so the signature gains `ctx`. Additive. |
| **`Date.now()` is pinned between I/O in Workers.** | Already burned us once on stream pacing. Do not use elapsed-time measurement for rate-limit windows inside a single request; use absolute bucket arithmetic instead. |
| **No router in the frontend.** `App.tsx` renders one screen. | `/admin` needs routing. A ~30-line path hook keeps the zero-dependency style rather than pulling in react-router. |
| **`MessageItem` is `memo()`d and callbacks are ref-stabilised** because streaming re-renders the thread. | Auth/session context must not be passed down in a way that breaks that. Put auth in a context read by leaves, not threaded through message props. |
| **oxlint + three TS projects**, worker project has `erasableSyntaxOnly`. | No constructor parameter properties in worker code. New worker files join `worker/tsconfig.json` automatically (`include: ["**/*.ts"]`). |

### 1.3 Current upload handling

**There is none.** No attachment button, no file input, no multipart parsing, no
R2 binding, no `files` table, and no multimodal content parts — `buildBody()`
sends `content` as a plain string. The entire pipeline in §6 is new code, which
means no legacy upload behaviour to preserve.

---

## 2. What changes, and what must not

### Must not change

1. The SSE frame contract and `paced()` client-side pacing.
2. The AgentRouter integration quirks: the `claude-cli`-shaped User-Agent, and
   `max_completion_tokens` with no `temperature`.
3. The retry rule — retries only before first byte, never mid-stream.
4. Abort chaining: Stop → client abort → Worker signal → upstream cancel.
5. Markdown rendering without `rehype-raw` (this is the XSS defence).
6. The 503-means-mock behaviour for a genuinely unconfigured backend.

### Changes deliberately

| Change | Why |
| --- | --- |
| `POST /api/chat` body becomes `{sessionId?, content, attachments?, model?}` | Server-authoritative history; client can no longer forge turns |
| CORS stops echoing arbitrary origins | With auth present, an allowlist is required |
| `fetch(request, env)` → `fetch(request, env, ctx)` | `waitUntil` for post-stream writes |
| `GET /api/models` returns capability records | Vision detection needs structured capabilities, not raw IDs |
| Chat requires a verified Firebase token | Your decision; makes logging and quotas meaningful |

---

## 3. Data model

D1 database `chatddb-f5-db`, managed with Wrangler's built-in migrations
(`migrations/` + `d1 migrations apply`). Timestamps are `INTEGER` Unix
milliseconds to match the existing frontend types (`createdAt: number`) — no
string/date conversion anywhere.

### 3.1 `users`

```sql
CREATE TABLE users (
  id              TEXT PRIMARY KEY,           -- uuid, our identifier
  firebase_uid    TEXT NOT NULL UNIQUE,       -- from the verified token, never the client
  email           TEXT NOT NULL,
  name            TEXT,
  profile_picture TEXT,
  role            TEXT NOT NULL DEFAULT 'user'   CHECK (role IN ('user','admin')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at      INTEGER NOT NULL,
  last_login      INTEGER,
  login_count     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role_status ON users(role, status);
```

`role` and `status` live **only** here — never in the token, never trusted from
the client. `login_count` is a cheap denormalisation for the admin dashboard.

### 3.2 `chat_sessions`

```sql
CREATE TABLE chat_sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  model_used    TEXT,                    -- last model used in this session
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER                  -- soft delete
);
CREATE INDEX idx_sessions_user_updated ON chat_sessions(user_id, updated_at DESC);
CREATE INDEX idx_sessions_updated ON chat_sessions(updated_at DESC);
```

`message_count` is denormalised on purpose: the sidebar and the admin user table
both list sessions, and `COUNT(*)` per row would multiply D1 row reads against a
Free-tier budget. It is maintained in the same batch as the message insert.

Soft delete: a user deleting a chat sets `deleted_at` and it disappears from
their UI, but an abuse investigation still has the record. This is stated in the
privacy notice (§8) rather than hidden.

### 3.3 `chat_messages`

```sql
CREATE TABLE chat_messages (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  message_content   TEXT NOT NULL,
  model_provider    TEXT,                -- 'agentrouter'
  model_used        TEXT,                -- 'gpt-5.6-sol'
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  token_source      TEXT,                -- 'upstream' | 'estimate' | NULL
  attachment_count  INTEGER NOT NULL DEFAULT 0,
  finish_reason     TEXT,
  error             TEXT,                -- set when generation failed
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_messages_session_created ON chat_messages(session_id, created_at);
CREATE INDEX idx_messages_user_created ON chat_messages(user_id, created_at DESC);
CREATE INDEX idx_messages_created ON chat_messages(created_at DESC);
```

`user_id` duplicates `chat_sessions.user_id`. That is deliberate and is what the
spec's "add indexes for user_id" asks for: admin queries like "everything this
user said last week" and per-user quota counting would otherwise need a join on
every row read. It is one indexed column, not a copy of content.

**Token usage is not guaranteed.** AgentRouter synthesises its stream, and
whether it forwards a `usage` block is unverified (§14). The plan: request
`stream_options: {include_usage: true}`, record `token_source='upstream'` when it
arrives, otherwise store a `chars/4` estimate marked `'estimate'`. The admin UI
labels estimates as such rather than presenting them as billing truth.

### 3.4 `activity_logs`

```sql
CREATE TABLE activity_logs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,  -- NULL for pre-auth events
  action     TEXT NOT NULL,
  metadata   TEXT,          -- JSON string, no PII beyond ids
  ip_hash    TEXT,          -- SHA-256(ip + salt), truncated; raw IP never stored
  user_agent TEXT,          -- truncated to 256 chars
  severity   TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','alert')),
  timestamp  INTEGER NOT NULL
);
CREATE INDEX idx_activity_user_ts ON activity_logs(user_id, timestamp DESC);
CREATE INDEX idx_activity_action_ts ON activity_logs(action, timestamp DESC);
CREATE INDEX idx_activity_severity_ts ON activity_logs(severity, timestamp DESC);
```

Action vocabulary, defined as a union type in one place so the admin filter and
the writers cannot drift:

`login`, `logout`, `login_denied_suspended`, `chat_started`, `message_sent`,
`model_selected`, `file_uploaded`, `file_deleted`, `file_processed`,
`rate_limited`, `suspicious_activity`, `admin_chat_access`, `admin_file_access`,
`admin_user_updated`, `admin_login`.

### 3.5 `files`

```sql
CREATE TABLE files (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id             TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
  message_id             TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
  filename               TEXT NOT NULL,   -- sanitised storage name
  original_filename      TEXT NOT NULL,   -- as uploaded, for display only
  file_type              TEXT NOT NULL CHECK (file_type IN ('image','pdf')),
  mime_type              TEXT NOT NULL,   -- sniffed, not client-declared
  file_size              INTEGER NOT NULL,
  r2_key                 TEXT NOT NULL UNIQUE,
  sha256                 TEXT,
  upload_status          TEXT NOT NULL DEFAULT 'pending'
                           CHECK (upload_status IN ('pending','stored','failed')),
  processing_status      TEXT NOT NULL DEFAULT 'none'
                           CHECK (processing_status IN ('none','pending','done','failed','unsupported')),
  extracted_text_key     TEXT,      -- R2 key of the full extracted text
  extracted_text_preview TEXT,      -- first ~2 KB, for admin display without an R2 read
  extracted_chars        INTEGER,
  extracted_pages        INTEGER,
  extraction_source      TEXT CHECK (extraction_source IN ('worker','client')),
  created_at             INTEGER NOT NULL
);
CREATE INDEX idx_files_user_created ON files(user_id, created_at DESC);
CREATE INDEX idx_files_message ON files(message_id);
CREATE INDEX idx_files_session ON files(session_id);
CREATE INDEX idx_files_status ON files(processing_status);
```

Extracted text goes to **R2, not D1**. A 25 MB PDF can yield megabytes of text
and D1 responses are capped around 1 MB; this is also literally what the spec
asks for ("store extracted text reference"). D1 keeps a 2 KB preview so the
admin file list needs no R2 reads.

`message_id` is nullable because a file is uploaded *before* the message that
carries it exists. Orphans (uploaded, never sent) are pruned after 24 h.

### 3.6 Relationships and future-ready tables

```
users ──┬── chat_sessions ── chat_messages ── files
        ├── activity_logs
        └── files (owner, even before a message exists)
```

Deliberately deferred, documented so the schema does not have to be rethought:
`file_chunks(id, file_id, idx, text, token_count, embedding BLOB)` for RAG, and
`usage_daily(user_id, day, messages, tokens, bytes_uploaded)` as a rollup if the
Free-tier write budget becomes the binding constraint.

### 3.7 Migrations

```
migrations/
  0001_users_and_activity.sql
  0002_chat_sessions_and_messages.sql
  0003_files.sql
```

Split by concern so a partial rollout is possible, applied with
`wrangler d1 migrations apply` (§13). Wrangler tracks applied migrations in a
`d1_migrations` table — no custom runner needed.

---

## 4. Backend design

### 4.1 Module layout

`worker/index.ts` is currently 283 lines doing routing, validation, and error
mapping. It becomes a thin router; logic moves into services. New structure:

```
worker/
  index.ts               router + CORS + error mapping only
  models.ts              NEW  model registry & capabilities
  agentrouter.ts         MOD  multimodal content parts, usage request
  sse.ts                 MOD  optional onComplete(text, meta) tap
  auth/
    verify.ts            NEW  Firebase ID token verification (jose + JWKS)
    middleware.ts        NEW  requireAuth / requireAdmin / resolveUser
  db/
    client.ts            NEW  D1 helpers, batch, typed row mappers
    users.ts             NEW  upsert on login, suspend, role change, stats
    sessions.ts          NEW  session CRUD, history rebuild, counters
    messages.ts          NEW  insert user/assistant messages, transcripts
    activity.ts          NEW  log(), query with filters
    files.ts             NEW  metadata CRUD, ownership checks, storage stats
  routes/
    chat.ts              MOD  moved from index.ts + persistence
    auth.ts              NEW  POST /api/auth/session, POST /api/auth/logout, GET /api/me
    sessions.ts          NEW  chat history REST
    files.ts             NEW  upload / view / delete
    admin.ts             NEW  all /api/admin/* handlers
  lib/
    http.ts              NEW  json(), errors, CORS (extracted from index.ts)
    validate.ts          NEW  shared body/param validation
    ratelimit.ts         NEW  D1 sliding-window counters
    hash.ts              NEW  ip_hash, sha256, HMAC signing for file URLs
    suspicious.ts        NEW  heuristics → activity_logs
    files/
      detect.ts          NEW  magic-byte + MIME + extension validation
      pdf-client.ts      NEW  accept & verify client-extracted text (Free plan)
      pdf-worker.ts      NEW  unpdf extraction (flag-gated, Paid plan)
      context.ts         NEW  chunking + attachment→prompt assembly
```

Every service takes its dependencies as arguments (`db: D1Database`) rather than
reading a global env — testable, and it matches the existing `resolveConfig(env)`
style of passing config explicitly.

### 4.2 Authentication

**No Firebase Admin SDK and no service-account key.** Verification is pure
JWT-over-WebCrypto, which means there is no admin private key in this system to
leak. Using [`jose`](https://github.com/panva/jose) (works on Workers,
standards-based, caches the key set):

```ts
const JWKS = createRemoteJWKSet(new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
))

const { payload } = await jwtVerify(token, JWKS, {
  issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
  audience: env.FIREBASE_PROJECT_ID,
  algorithms: ['RS256'],
})
// then: payload.sub non-empty, payload.auth_time <= now, email_verified for Google
```

Key rotation is handled by `createRemoteJWKSet` (re-fetch on `kid` miss); keys
are never hardcoded. `FIREBASE_PROJECT_ID` is a plain var — public information.

Flow:

1. Client signs in with Google via the Firebase JS SDK, gets an ID token.
2. Client calls `POST /api/auth/session` with `Authorization: Bearer <idToken>`.
3. Worker verifies, then upserts `users` on `firebase_uid`: creates the row on
   first sight (role from `ADMIN_EMAILS` if listed, else `user`), updates
   `email`/`name`/`profile_picture`/`last_login`/`login_count` after.
4. Rejects with 403 if `status='suspended'`, logging `login_denied_suspended`.
5. Logs `login`, returns the D1 user record — **this** is the source of truth for
   role, not the token.
6. Every subsequent request repeats verification (cheap: cached JWKS, no network)
   and re-reads the user row for `role`/`status`.

Token lifetime is Firebase's 1 hour; the client refreshes via
`onIdTokenChanged` and retries once on 401. Suspension takes effect on the next
request because `status` is read from D1 each time, not baked into the token.

### 4.3 Endpoint map

Auth column: `—` public, `U` any active user, `A` admin only.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | — | Adds `db`/`r2`/`auth` readiness flags |
| GET | `/api/models` | U | Capability records (§4.5) |
| POST | `/api/auth/session` | token | Verify, upsert user, log login, return profile |
| POST | `/api/auth/logout` | U | Log logout (token invalidation is client-side) |
| GET | `/api/me` | U | Current profile + usage summary |
| POST | `/api/chat` | U | Stream a reply; persists both messages |
| GET | `/api/sessions` | U | List own sessions (paginated) |
| POST | `/api/sessions` | U | Create session |
| GET | `/api/sessions/:id` | U | Own transcript |
| PATCH | `/api/sessions/:id` | U | Rename |
| DELETE | `/api/sessions/:id` | U | Soft delete |
| POST | `/api/sessions/import` | U | One-time localStorage import (§5.4) |
| POST | `/api/files` | U | Upload (multipart), validate, store, register |
| GET | `/api/files/:id` | U | Metadata |
| GET | `/api/files/:id/view` | sig | Bytes, via short-lived HMAC URL (§6.4) |
| DELETE | `/api/files/:id` | U | Delete own file (R2 + row) |
| GET | `/api/admin/stats` | A | Totals, DAU, recent registrations |
| GET | `/api/admin/users` | A | User table, search + sort + paginate |
| GET | `/api/admin/users/:id` | A | Detail: sessions, files, recent activity |
| PATCH | `/api/admin/users/:id` | A | Suspend/reactivate, change role |
| GET | `/api/admin/activity` | A | Activity feed, filtered by date/user/action |
| GET | `/api/admin/sessions` | A | Search conversations across users |
| GET | `/api/admin/sessions/:id` | A | Transcript — **writes `admin_chat_access`** |
| GET | `/api/admin/files` | A | File monitoring, storage usage |
| GET | `/api/admin/files/:id/view` | A | Inspect a file — **writes `admin_file_access`** |

### 4.4 Chat request flow after the change

```
POST /api/chat  {sessionId?, content, attachments?: [{fileId}], model?}
  1 requireAuth            → user (401/403; never 404/502/503)
  2 rate limit             → 429 + log rate_limited
  3 validate               → content length, attachment count, model id
  4 model capability       → 400 model_no_vision if images + non-vision model
  5 session                → create (log chat_started) or verify ownership
  6 attachments            → verify each file: owner = user, upload_status='stored'
  7 history                → rebuild from D1 (last N turns, char-capped)
  8 assemble               → text + image parts + PDF extracted-text context
  9 insert user message    → D1 (+ link files.message_id, log message_sent)
 10 stream                 → createChatCompletion(), unchanged internals
 11 tee                    → accumulate assistant text as frames are written
 12 ctx.waitUntil          → insert assistant message, bump counters, usage
```

Steps 1–9 are ordinary request work. Step 11 is a small additive change to
`toClientStream(res, {onComplete})` — the frames written to the client are
untouched, we just accumulate a copy. Step 12 runs after the response closes, so
persistence never delays a token.

If the stream dies mid-flight, the partial assistant text is still persisted with
`error` set — matching what the user saw on screen, which matters for
investigating complaints.

**Abort:** on client abort we still persist the partial text (the user saw it),
mark `finish_reason='aborted'`, and skip usage.

### 4.5 Model registry

```ts
export interface ModelSpec {
  id: string; label: string; provider: 'agentrouter'
  vision: boolean; documents: boolean
  contextTokens: number; maxOutputTokens: number
  reasoning: boolean; default?: boolean
}
```

One entry for now (`gpt-5.6-sol`), per your decision. `GET /api/models` returns
these records; the raw upstream list moves behind `?upstream=1`, admin-only,
since it is a debugging tool.

The `vision` flag is what produces the spec's required message. Backend returns
400 `model_no_vision` with *"This model does not support image analysis. Please
select a vision-capable model."*; the frontend also disables the image attach
button so the error is hard to reach. Adding a model later = one array entry.

Whether AgentRouter actually passes multimodal parts through for `gpt-5.6-sol` is
unverified — Phase 4 starts with a probe (§14).

### 4.6 Rate limiting

Cloudflare's `ratelimits` binding is
[GA](https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/)
but its counters are per-location and its period is fixed at 10 or 60 seconds —
no good for "300 messages per day per user". So: D1 counter table with absolute
bucket arithmetic (not elapsed-time math, which `Date.now()` pinning breaks).

```sql
CREATE TABLE rate_counters (
  subject     TEXT NOT NULL,   -- 'user:<id>' | 'ip:<hash>'
  window_kind TEXT NOT NULL,   -- 'minute' | 'day'
  window_start INTEGER NOT NULL,
  action      TEXT NOT NULL,   -- 'chat' | 'upload' | 'auth'
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, window_kind, action, window_start)
);
```

Starting limits (all env-tunable): chat 20/min and 300/day per user; upload
10/min and 100/day; auth 30/min per IP hash; admin reads 120/min. Exceeding logs
`rate_limited` and returns 429 with `Retry-After`.

Cost note: this is one D1 write per limited request. Against the Free tier's
100k writes/day that is affordable but not free — §9.1 does the arithmetic.

---

## 5. Frontend design

### 5.1 Auth surface

- `src/lib/firebase.ts` — initialise the app from `VITE_FIREBASE_*` build vars.
  These are **public by design**; Firebase web API keys are identifiers, not
  secrets. Documented so nobody later "fixes" it by moving them server-side.
- `src/lib/auth.tsx` — `AuthProvider` + `useAuth()`. Wraps `onIdTokenChanged`,
  exposes `{user, profile, loading, signIn, signOut, getToken}`. `profile` is the
  **D1** record (has `role`), fetched from `POST /api/auth/session`.
- `src/lib/apiClient.ts` — one authorised `fetch` wrapper: attaches the bearer
  token, retries once after a forced token refresh on 401, maps
  `{error:{message}}` bodies to thrown errors. Everything else uses it.
- `src/components/LoginScreen.tsx` — the ChatDDB logo, one "Continue with
  Google" button, and the privacy notice (§8). Shown whenever there is no
  session; the chat UI does not mount at all.
- `src/components/UserMenu.tsx` — avatar in the header, name/email, "Admin panel"
  link when `profile.role === 'admin'`, sign out.

Session persistence is Firebase's default (IndexedDB), so a refresh keeps the
user logged in. Auth state is context, read by the components that need it —
message components stay `memo()`-clean.

### 5.2 Chat changes

`App.tsx` keeps its shape: state, `runAssistantTurn`, the `latest` ref
optimisation. What changes is where conversations come from — `/api/sessions`
instead of `localStorage`, with optimistic local updates so typing still feels
instant. `streamChat` keeps its generator signature and `paced()`; only the
request body and the added `Authorization` header change.

`localStorage` becomes a cache of the active session for reload-resilience, not
the system of record.

### 5.3 Attachment UI

| Component | Role |
| --- | --- |
| `Composer.tsx` (mod) | Paperclip button, paste-to-upload, disabled state + reason when the model lacks vision |
| `AttachmentTray.tsx` | Row of pending attachments above the textarea; remove before sending |
| `AttachmentChip.tsx` | Image thumbnail, or PDF icon + filename + size; per-file progress bar and error state |
| `ChatArea.tsx` (mod) | Full-area drag-and-drop overlay while dragging files |
| `MessageItem.tsx` (mod) | Renders sent attachments: image thumbnails (click to enlarge), PDF chips |

Upload uses `XMLHttpRequest`, not `fetch` — `fetch` has no upload progress event,
and the spec asks for a progress indicator. Images are downscaled client-side to
1568 px on the long edge before upload (vision models gain nothing from more, and
it cuts both upload time and token cost); the original is still what goes to R2.

### 5.4 Existing local history

On first successful login, if `chatddb.conversations` holds chats, offer a
one-time import: *"Import N conversations from this browser?"* → `POST
/api/sessions/import` (validated, capped, rate-limited), then mark the local blob
imported rather than deleting it, so a failed import is not data loss. Declining
leaves the local data untouched and unimported.

I am assuming an offer rather than a silent auto-import — tell me if you would
rather it just happen.

### 5.5 Admin panel

Routing: a ~30-line `useRoute()` hook over `history.pushState` + `popstate`,
matching `/` and `/admin/*`. No react-router — the existing code has no router
dependency and two routes do not justify one. SPA asset fallback already serves
`index.html` for `/admin`, so deep links work.

```
src/components/admin/
  AdminApp.tsx        route guard (profile.role === 'admin') + tab shell
  StatCards.tsx       total / active / new-today / DAU
  UsersTable.tsx      search, sort, paginate; suspend + role actions
  UserDetail.tsx      drawer: profile, sessions, files, recent activity
  ActivityFeed.tsx    filters: date range, user, action type, severity
  ChatInspector.tsx   session search → transcript (plain text, never markdown)
  FileMonitor.tsx     counts, storage usage, recent uploads, per-user activity
  Sparkline.tsx       inline SVG DAU chart — no chart library
```

Two deliberate choices: the guard is UI convenience only (every `/api/admin/*`
route enforces server-side), and the inspector renders chat content as **plain
text** — an admin viewing hostile content should not be rendering it.

---

## 6. File upload pipeline

### 6.1 Why upload through the Worker

The spec suggests presigned URLs "where possible". At our size caps they are the
wrong tool:

- Presigned R2 URLs need S3-API access keys as Worker secrets — *more* credential
  surface, exactly what "do not expose bucket credentials" is guarding against.
- They only work on the `r2.cloudflarestorage.com` endpoint, require separate CORS
  config, and **cannot enforce a maximum upload size**.
- The 100 MB Worker request-body limit is 4× our largest allowed file (25 MB), so
  it is not a constraint here.

So: upload through the Worker via the R2 binding, where size, MIME, and magic
bytes are all checked server-side before a byte is stored. Presigned/multipart is
documented as the path if limits ever rise past ~100 MB.

### 6.2 Validation

Every check is server-side; the client's `Content-Type` and filename are hints
only.

1. **Size** — `Content-Length` pre-check, then actual byte count: images
   `MAX_IMAGE_BYTES` (10 MB default), PDFs `MAX_PDF_BYTES` (25 MB default).
2. **Extension allowlist** — `.png .jpg .jpeg .webp .pdf`.
3. **Magic bytes** — `‰PNG␍␊`, `ÿØÿ`, `RIFF····WEBP`, `%PDF-`. A file whose
   sniffed type disagrees with its extension is rejected, not corrected.
4. **SVG is explicitly not supported** — it is script-capable, and "image" in a
   chat context does not need it.
5. **Filename sanitised** for storage; the original kept for display only and
   escaped by React on render.
6. **Per-message cap** — `MAX_ATTACHMENTS_PER_MESSAGE` (4 default).

R2 key: `u/<user_id>/<yyyy>/<mm>/<file_id>.<ext>` — user-scoped, so a key alone
never grants access and per-user usage is a prefix listing.

Honest limit: this is validation, not antivirus. Real malware scanning is not
feasible in-Worker on the Free plan; what we have is type confinement, no
execution path, and `Content-Disposition: attachment` on download. A hash
denylist and an external scanning hook are noted as future work.

### 6.3 Upload sequence

```
1 POST /api/files (multipart)  → requireAuth, rate limit
2 validate size/ext/magic      → 400 on failure, nothing stored
3 insert files row             → upload_status='pending'
4 R2 put                       → key, contentType, customMetadata{userId,fileId}
5 update row                   → upload_status='stored', sha256
6 log file_uploaded
7 PDF only → processing_status='pending' → extraction (§6.5)
8 return {fileId, type, size, viewUrl?, processing_status}
```

Row-before-put means a crashed upload leaves a `pending` row to prune, never an
untracked object. Orphans (no `message_id` after 24 h) are pruned by the
maintenance command.

### 6.4 Serving files back

Images must render in `<img>` tags, which cannot send an `Authorization` header,
and putting a Firebase token in a URL would leak it into history and logs.
Solution: the Worker mints its own short-lived signed URL.

```
GET /api/files/:id/view?exp=<unix>&sig=<hmac-sha256(fileId|exp|userId, FILE_URL_SECRET)>
```

Minted only for the owner (or an admin, which additionally writes
`admin_file_access`), 15-minute expiry, verified in constant time. Response
carries `Cache-Control: private, max-age=900`, `X-Content-Type-Options: nosniff`,
and `Content-Disposition: attachment` for PDFs (inline only for the image types
we sniffed). The bucket itself is never public and has no custom domain.

### 6.5 PDF processing

```
PDF in R2 ─▶ extract text ─▶ store full text as R2 object + 2KB preview in D1
                          └▶ chunk on demand ─▶ inject a bounded slice into the prompt
```

Extraction has **two implementations behind one interface**, selected by
`PDF_EXTRACT_MODE`:

- `worker` — [`unpdf`](https://github.com/unjs/unpdf) inside the Worker. Your
  preferred design and the one Cloudflare's own R2 tutorial uses. **Requires the
  Paid plan** (§9.2).
- `client` — the browser extracts with pdf.js and posts the text alongside the
  file. Works on Free. The text is then *client-supplied*, so it is stored with
  `extraction_source='client'`, labelled in the admin UI, length-capped, and the
  original PDF is kept as the authority for later re-extraction.

Blast radius of the weaker mode, stated plainly: a user could send text that does
not match their PDF. That pollutes their own conversation and their own log rows.
It cannot touch another user's data, and it is not an injection vector into the
Worker. Re-extracting server-side after a plan upgrade corrects the records.

Context assembly never sends a whole document: `PDF_CONTEXT_CHARS` (24k default)
of the most relevant chunks, wrapped in a delimiter block that tells the model
this is an attached document. Chunking is paragraph-aware with overlap, and the
chunk boundaries are exactly what a future `file_chunks` + embeddings table would
index — the RAG upgrade becomes "store vectors for chunks we already cut".

### 6.6 Images to the model

Content parts, OpenAI style:

```jsonc
{ "role": "user", "content": [
  { "type": "text", "text": "Explain this circuit diagram" },
  { "type": "image_url", "image_url": { "url": "data:image/png;base64,…" } }
]}
```

Data URLs rather than links, because our files are deliberately not publicly
reachable. `buildBody()` in `agentrouter.ts` gains a content-parts branch; the
string path stays for text-only turns so nothing about today's behaviour changes.
Per the spec, model analysis output is not stored separately — it is just the
assistant message.

---

## 7. Security model

| Requirement | Implementation |
| --- | --- |
| **RBAC** | `role` in D1 only. `requireAdmin` re-reads it per request. Client-side role checks are cosmetic. |
| **Protected routes** | Single `requireAuth`/`requireAdmin` chokepoint; the router cannot reach a handler without passing it. Suspension enforced on every request. |
| **Token verification** | RS256 + Google JWKS via `jose`, `iss`/`aud`/`exp`/`iat`/`sub` all checked, key rotation handled. No Firebase Admin key exists in the system. |
| **Input validation** | Existing `LIMITS` retained and extended; one `validate.ts` for bodies, ids (UUID shape), pagination bounds, date ranges, enum params. Reject-not-coerce. |
| **SQL injection** | D1 prepared statements with bound parameters, always. No string-built SQL, including in admin search — `LIKE ?` with escaped wildcards. |
| **XSS** | No `rehype-raw`, no `dangerouslySetInnerHTML`; admin views render chat as plain text; CSP + `nosniff` via `public/_headers`; SVG uploads refused; filenames escaped. |
| **CSRF** | Auth is a bearer header, never a cookie — there are no ambient credentials to ride, so classic CSRF does not apply. Reinforced by: JSON `Content-Type` required on state-changing routes, no `Access-Control-Allow-Credentials`, and an `ALLOWED_ORIGINS` allowlist replacing today's origin echo. |
| **Rate limiting** | §4.6, per-user and per-IP-hash, logged on trip. |
| **Ownership** | Every session/message/file query is filtered by `user_id` in SQL, not checked after fetch. Admin access is a separate, audited path. |
| **Secrets** | AgentRouter key, `IP_HASH_SALT`, `FILE_URL_SECRET` as Wrangler secrets. `FIREBASE_PROJECT_ID` and `VITE_FIREBASE_*` are public identifiers, documented as such. Nothing secret reaches `/api/health` or the bundle. |
| **Suspicious activity** | `lib/suspicious.ts` flags: rate-limit trips, sustained burst rates, repeated identical prompts, upload floods, oversize/invalid-type attempts, many distinct IP hashes per user in a short window, repeated auth failures. Writes `suspicious_activity` with `severity` and evidence in `metadata`. |

Explicitly out of scope, so it is not mistaken for done: bot detection, IP
reputation, malware scanning, and content moderation of *what* users ask (only
abuse patterns are flagged, not topics).

---

## 8. Privacy and audit

The spec asks for monitoring *and* privacy. Concretely:

1. **Disclosure before consent.** The login screen states, above the Google
   button, that conversations and uploads are stored and may be reviewed by
   administrators for security and abuse prevention. A short `PRIVACY.md` and a
   persistent link in the user menu carry the full text.
2. **Data minimisation.** Raw IPs are never written — only
   `SHA-256(ip + IP_HASH_SALT)`, truncated, which supports "same origin?"
   correlation without being reversible to an address. User agents truncated.
   Log `metadata` carries ids and counts, not message content.
3. **Every admin look at private data is logged.** `admin_chat_access` and
   `admin_file_access` rows record which admin, which target user, which session
   or file, and when. These are written on the read path, before the response is
   returned.
4. **Audit rows are not deletable through the API.** No admin endpoint deletes
   from `activity_logs`; retention pruning is an operator command, not a UI
   button.
5. **Admins are visible in the same feed** they use to watch users — admin
   actions appear in the activity view like any other action.
6. **Retention.** `activity_logs` older than 90 days and orphaned files older
   than 24 h are prunable via `npm run db:prune`. Defaults documented; nothing
   is silently kept forever.

---

## 9. Free-plan constraints

Verified against Cloudflare's
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

### 9.1 The numbers that bind

| Limit (Free) | Value | Consequence |
| --- | --- | --- |
| CPU per request | **10 ms** | No PDF parsing in-Worker (§9.2). Everything else here is I/O-bound, which does not count. |
| Worker bundle | 3 MB gzipped | unpdf (~1.6 MB min) stays out of the bundle on Free. |
| Requests | 100k/day | Fine; the D1 write budget binds first. |
| Subrequests | 50/request | Chat uses ~1–4. Fine. |
| Memory | 128 MB | A 25 MB PDF plus base64 image parts fits, but caps must be enforced. |
| D1 writes | **100k rows/day**, and an indexed column write costs an extra row | A chat turn costs ~5 logical writes → ~15–20 physical rows. Budget ≈ **5–7k messages/day**. |
| D1 reads | 5M rows/day | Comfortable. |
| D1 storage | 5 GB | Message text dominates; ~years at this scale. |
| R2 | 10 GB, 1M class-A ops/mo | ~400 PDFs at 25 MB. Fine to start. |
| Queues / cron CPU | unavailable / 10 ms | No background jobs. Pruning is an operator command, not a scheduled task. |

Mitigations built in from the start: rate limits keep any one user from eating the
write budget; `usage_daily` rollups are pre-designed if logging volume becomes the
constraint; and `activity_logs` writes for high-frequency actions are the first
thing to sample if writes get tight.

### 9.2 The Free plan blocks worker-side PDF parsing

You chose server-side extraction via unpdf *and* the Workers Free plan. Those two
answers are incompatible, so I am flagging it rather than quietly picking one:
**Free allows 10 ms CPU per request, and PDF.js parsing is pure CPU measured in
hundreds of milliseconds to seconds per document** — one page would blow the
budget by 10–100× and return
[error 1102](https://developers.cloudflare.com/workers/platform/limits/). Free
also has no Queues and 10 ms cron CPU, so there is no background path either.

How the plan handles it, honoring your architectural preference without shipping
something that cannot run:

- Both extractors are written against one `PdfExtractor` interface.
- `PDF_EXTRACT_MODE=client` is the default and what runs on Free.
- `PDF_EXTRACT_MODE=worker` + adding the unpdf import switches to your preferred
  design; on the Paid plan (30 s CPU, Queues) it is a two-line change plus a
  bundle-size check.
- Files carry `extraction_source`, so records made under either mode are
  distinguishable and re-extractable.

If you would rather upgrade to Paid ($5/mo) before Phase 4, tell me and I will
make `worker` the default and drop the client extractor to a fallback. The
upgrade also removes the D1 daily write caps, which is the other Free-tier
pressure point.

---

## 10. File-by-file change list

### New — worker (24 files)

`models.ts`, `auth/verify.ts`, `auth/middleware.ts`, `db/client.ts`,
`db/users.ts`, `db/sessions.ts`, `db/messages.ts`, `db/activity.ts`,
`db/files.ts`, `routes/auth.ts`, `routes/chat.ts`, `routes/sessions.ts`,
`routes/files.ts`, `routes/admin.ts`, `lib/http.ts`, `lib/validate.ts`,
`lib/ratelimit.ts`, `lib/hash.ts`, `lib/suspicious.ts`, `lib/files/detect.ts`,
`lib/files/pdf-client.ts`, `lib/files/pdf-worker.ts`, `lib/files/context.ts`

### New — frontend (16 files)

`lib/firebase.ts`, `lib/auth.tsx`, `lib/apiClient.ts`, `lib/router.ts`,
`lib/upload.ts`, `components/LoginScreen.tsx`, `components/UserMenu.tsx`,
`components/AttachmentTray.tsx`, `components/AttachmentChip.tsx`,
`components/admin/{AdminApp,StatCards,UsersTable,UserDetail,ActivityFeed,ChatInspector,FileMonitor,Sparkline}.tsx`

### New — config, migrations, docs

`migrations/0001_users_and_activity.sql`, `0002_chat_sessions_and_messages.sql`,
`0003_files.sql`, `public/_headers`, `.env.local.example`, `PRIVACY.md`,
`smoke-auth.mjs`, `smoke-files.mjs`, `smoke-admin.mjs`

### Modified

| File | Change |
| --- | --- |
| `worker/index.ts` | Reduced to routing + CORS allowlist + error mapping; gains `ctx`; delegates to `routes/*` |
| `worker/agentrouter.ts` | Content-parts branch for images; `stream_options.include_usage`; model from registry |
| `worker/sse.ts` | Optional `onComplete(text, meta)` tap for persistence — frame output unchanged |
| `src/App.tsx` | Auth gate, routing, sessions from API, attachment state |
| `src/lib/api.ts` | New request body, bearer header, attachment plumbing; `paced()` untouched |
| `src/lib/storage.ts` | Local cache + import bookkeeping instead of system of record |
| `src/types.ts` | `User`, `Attachment`, `FileMeta`, `ModelSpec`, admin view types |
| `src/components/Composer.tsx` | Attach button, paste, drag-drop, capability-based disabling |
| `src/components/MessageItem.tsx` | Render attachments |
| `src/components/ChatArea.tsx` | Drop overlay |
| `src/components/Sidebar.tsx` | Server-backed history, pagination |
| `wrangler.jsonc` | Enable D1 + R2 bindings, new vars, `migrations_dir` |
| `package.json` | `firebase`, `jose`, `pdfjs-dist` (client mode); `db:*` scripts |
| `index.html` | CSP-compatible meta, Firebase preconnect |
| `smoke*.mjs` | Log in before driving the UI |
| `DOCS.md`, `README.md` | Rewritten for the new architecture |

Roughly 40 new files and 16 modified. `agentrouter.ts` and `sse.ts` — the two
files where the hard-won AgentRouter knowledge lives — get additive changes only.

---

## 11. Implementation phases

Every phase ends with `npm run build`, `npm run lint`, and
**`node smoke-backend.mjs` still passing** — that last one is the standing
guarantee that streaming never broke.

### Phase 0 — Provision and scaffold
Create D1 + R2, wire bindings, `migrations_dir`, write and apply migrations
locally, add `db/client.ts` and `lib/http.ts` (extracted from `index.ts`), extend
`/api/health` with `db`/`r2` readiness. No behaviour change.
*Gate:* `wrangler d1 migrations apply --local` clean, health reports both bound,
existing smoke tests pass untouched.

### Phase 1 — Auth backend
`jose` verification, users upsert, `requireAuth`/`requireAdmin`, activity logging,
`POST /api/auth/session`, `GET /api/me`, `ADMIN_EMAILS` bootstrap. `/api/chat`
not yet gated.
*Gate:* `smoke-auth.mjs` against the Firebase Auth emulator — verify a good
token, reject expired/wrong-audience/tampered tokens, and 403 a suspended user.

### Phase 2 — Auth frontend
Firebase SDK, `AuthProvider`, login screen with the privacy notice, user menu,
`apiClient` with refresh-and-retry, gate the chat UI, log logout.
*Gate:* real Google sign-in works; refresh keeps the session; sign-out clears it.

### Phase 3 — Chat persistence
Sessions/messages services and REST, `/api/chat` moved to `routes/chat.ts` with
server-authoritative history and `waitUntil` persistence, sidebar and `App.tsx`
on the API, one-time local import.
*Gate:* `smoke-backend.mjs` passes with auth; a reply survives a reload;
transcripts round-trip; a second account cannot read the first's sessions (an
explicit negative test).

### Phase 4 — Files
R2 upload/validate/store, signed view URLs, delete, attachment UI with progress
and previews, image content parts (**starting with the multimodal probe**), PDF
extraction behind `PDF_EXTRACT_MODE`, chunked context injection, capability
gating.
*Gate:* `smoke-files.mjs` — image round-trip and model response, PDF text
reaches the answer, oversize rejected, wrong magic bytes rejected, cross-user
access 403s, SVG refused.

### Phase 5 — Admin panel
Stats, users table with suspend/role actions, activity feed with filters, chat
inspector with `admin_chat_access` audit rows, file monitoring and storage usage.
*Gate:* `smoke-admin.mjs` — a non-admin gets 403 on every `/api/admin/*` route;
viewing a transcript writes exactly one audit row; suspension takes effect on the
suspended user's next request.

### Phase 6 — Hardening
Rate limits, suspicious-activity heuristics, `public/_headers` CSP, CORS
allowlist, `db:prune`, and a burst test that trips the limiter and confirms the
log rows.

### Phase 7 — Documentation
`DOCS.md` rewritten (auth, data model, admin, files, privacy), `PRIVACY.md`,
README, env-var reference, migration and admin-setup runbooks.

Phases 0–3 are the critical path; 4 is the largest single chunk; 5 is broad but
mechanical. Each is independently deployable, and each leaves the app working.

---

## 12. Environment variables

### Worker secrets (`wrangler secret put` / `.dev.vars`)

| Name | Purpose |
| --- | --- |
| `AGENTROUTER_API_KEY` | Existing |
| `IP_HASH_SALT` | Salt for `ip_hash`; rotating it deliberately breaks old correlations |
| `FILE_URL_SECRET` | HMAC key for signed file-view URLs |

### Worker vars (`wrangler.jsonc`)

| Name | Default | Purpose |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID` | — | Token `iss`/`aud` verification. Public identifier |
| `ADMIN_EMAILS` | empty | Comma-separated; promoted to admin on login |
| `ALLOWED_ORIGINS` | prod + localhost | CORS allowlist |
| `MAX_IMAGE_BYTES` | `10485760` | 10 MB |
| `MAX_PDF_BYTES` | `26214400` | 25 MB |
| `MAX_ATTACHMENTS_PER_MESSAGE` | `4` | |
| `PDF_EXTRACT_MODE` | `client` | `client` on Free, `worker` on Paid (§9.2) |
| `PDF_MAX_PAGES` | `50` | Extraction page cap |
| `PDF_CONTEXT_CHARS` | `24000` | Max extracted text injected per message |
| `HISTORY_MAX_TURNS` | `30` | Turns rebuilt from D1 per request |
| `RATE_CHAT_PER_MIN` / `_PER_DAY` | `20` / `300` | |
| `RATE_UPLOAD_PER_MIN` / `_PER_DAY` | `10` / `100` | |
| `ACTIVITY_RETENTION_DAYS` | `90` | |

Existing vars (`AGENTROUTER_MODEL`, `AGENTROUTER_BASE_URL`,
`AGENTROUTER_USER_AGENT`, `MAX_OUTPUT_TOKENS`, `UPSTREAM_TIMEOUT_MS`,
`REASONING_EFFORT`, `SYSTEM_PROMPT`) are unchanged.

### Frontend build vars (`.env.local`, public)

`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`,
`VITE_FIREBASE_APP_ID`.

These ship in the bundle by design — Firebase web keys identify a project, they
do not authorise anything. Access control is Firebase Auth rules plus our own
token verification. Documented so a future reader does not "fix" it.

### Bindings

`DB` → `chatddb-f5-db` (D1); `FILES` → `chatddb-f5-storage` (R2).

---

## 13. Operational commands

### One-time provisioning

```bash
npx wrangler d1 create chatddb-f5-db          # copy database_id into wrangler.jsonc
npx wrangler r2 bucket create chatddb-f5-storage
npx wrangler secret put AGENTROUTER_API_KEY
npx wrangler secret put IP_HASH_SALT
npx wrangler secret put FILE_URL_SECRET
```

### Migrations

```bash
npm run db:migrate:local      # wrangler d1 migrations apply chatddb-f5-db --local
npm run db:migrate            # ... --remote
npm run db:migrations:list    # applied vs pending
npm run db:studio             # wrangler d1 execute --command, ad-hoc queries
npm run db:prune              # retention: old activity rows, orphan files
```

### Admin setup

Preferred, no SQL:

```bash
# add to wrangler.jsonc vars, then redeploy and log in
"ADMIN_EMAILS": "you@example.com"
```

Or promote an existing user directly:

```bash
npx wrangler d1 execute chatddb-f5-db --remote \
  --command "UPDATE users SET role='admin' WHERE email='you@example.com'"
```

### Firebase setup (console, one-time)

Create the project → enable Google under Authentication → add a Web app → copy
the config into `.env.local` → add `localhost` and the Worker's domain to
Authorized domains → put the project id in `FIREBASE_PROJECT_ID`.

### Deploy

```bash
npm run db:migrate      # migrations first, always
npm run deploy
```

---

## 14. Open questions and risks

| # | Item | Status / mitigation |
| --- | --- | --- |
| 1 | **Free plan vs worker-side PDF parsing** | Real conflict, §9.2. Ships `client` mode by default; say the word and I switch to Paid + `worker`. |
| 2 | **Does AgentRouter pass multimodal content parts for `gpt-5.6-sol`?** | Unverified. Phase 4 opens with a probe. If it fails, `vision: false` in the registry and the UI refuses images with the spec's message — the pipeline still stands for a future vision model. |
| 3 | **Does AgentRouter return a `usage` block?** | Unverified. `token_source` distinguishes upstream numbers from estimates, so the admin UI never overstates. |
| 4 | **Model list unconfirmed** | Blocked on a tooling failure while writing this; irrelevant to Phase 0–3, and you chose single-model for now. I'll enumerate before any picker work. |
| 5 | **D1 Free write budget ≈ 5–7k messages/day** | §9.1. Rate limits, and `usage_daily` rollups pre-designed if it binds. |
| 6 | **Auth smoke tests need tokens** | Firebase Auth emulator locally. No production bypass flag will exist — a dev backdoor in an auth system is worse than a thinner test. |
| 7 | **Client-extracted PDF text is untrusted** | Bounded: affects only that user's own context and logs. Labelled, capped, re-extractable. §6.5. |
| 8 | **`localStorage` import** | Assumed opt-in prompt, not silent migration. §5.4. |
| 9 | **Suspension mid-stream** | A suspended user's in-flight stream is not killed; enforcement starts at the next request. Acceptable — worst case is one more completion. |
| 10 | **Admin panel bundle size** | Already 537 KB in one chunk. Admin routes will be lazy-loaded (`React.lazy`) so ordinary users never download them; also the moment to split `highlight.js`. |

---

## Ready to start

Phase 0 touches no user-visible behaviour and is fully reversible. My
recommendation is to green-light 0–3 as one block (storage + auth + persistence),
review, then decide on Paid before Phase 4 given §9.2.
