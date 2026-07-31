# ChatDDB — Implementation pseudocode for the remaining phases

Companion to `PHASE2-PLAN.md`. The plan says *what and why*; this says *exactly what
to type, in what order*. Written after Phase 0/1 landed and the Phase 2/3 client
libraries were written, so every endpoint, header and field name below is copied
from the code that already exists — not invented.

Pseudocode is TypeScript-shaped but not compilable: `...` means "unchanged", and
comments in **bold** are the traps.

---

## 0. Ground rules that apply to every file

These are the mistakes that cost the most time, all of them silent until build:

1. **Frontend imports carry no extension.** `import { useAuth } from './lib/auth'`
   — never `'./lib/auth.tsx'`. `allowImportingTsExtensions` is on, so the *worker*
   side does use `.ts`; the app side must not. Mixing them compiles in dev and
   breaks the build.
2. **`import type` for anything type-only** (`verbatimModuleSyntax`). `import type
   { ReactNode } from 'react'`, then bare `ReactNode`. Never `React.ReactNode`
   without importing React.
3. **No constructor parameter properties** (`erasableSyntaxOnly`). Write
   `readonly status: number` as a field, assign it in the body.
4. **`noUnusedLocals` / `noUnusedParameters` are errors.** Delete unused imports
   as you go; do not leave a scaffolded prop unused.
5. **Auth/permission failures are 401 or 403 only.** The client historically read
   404/502/503 as "no backend". `authError()` can only produce 401/403 — keep it
   that way, and never add a 404 for "not signed in".
6. **The SSE frame contract is frozen**: `data: {"choices":[{"delta":{"content":…}}]}`
   then `data: [DONE]`. `smoke-backend.mjs` asserts `health.configured` at top
   level. Don't reshape either.
7. **Server assigns all ids.** They come back on the response headers
   `X-ChatDDB-Session-Id`, `X-ChatDDB-Message-Id`, `X-ChatDDB-Model`, already in
   `Access-Control-Expose-Headers`. `streamChat`'s `onMeta` hands them to you
   *before* the first token.
8. **React StrictMode double-invokes effects.** Every one-shot side effect (the
   history import, session establishment) must be guarded by a ref, not by
   "it's in a `[]` effect so it runs once".

### Endpoint reference (all confirmed against `worker/index.ts`)

| Method | Path | Guard | Response |
| --- | --- | --- | --- |
| POST | `/api/auth/session` | public | `{user}` |
| POST | `/api/auth/logout` | user | `{ok}` |
| GET | `/api/me` | user | `{user, usage, quota, models, pdfExtractMode}` |
| POST | `/api/chat` | user | SSE stream + `X-ChatDDB-*` headers |
| GET | `/api/models` | user | `{models, default}` |
| GET | `/api/sessions` | user | `{sessions, total, limit, offset}` |
| POST | `/api/sessions` | user | 201 `{session}` |
| POST | `/api/sessions/import` | user | `{imported:{sessions, messages}}` |
| GET | `/api/sessions/:id` | user | `{session, messages}` |
| PATCH | `/api/sessions/:id` | user | `{ok, title}` |
| DELETE | `/api/sessions/:id` | user | `{ok}` |
| GET | `/api/files` | user | `{files}` |
| POST | `/api/files` | user | 201 `{file}` |
| GET | `/api/files/:id` | user | `{file}` |
| DELETE | `/api/files/:id` | user | `{ok}` |
| GET | `/api/files/:id/url` | user | `{url, expiresAt, mimeType}` |
| GET | `/api/files/view?id&exp&sig` | **public** | raw bytes |
| GET | `/api/admin/stats` | admin | `{platform, storage, actions, generatedAt}` |
| GET | `/api/admin/users` | admin | `{users, total, limit, offset}` |
| GET | `/api/admin/users/:id` | admin | `{user, usage, activity, sessions}` |
| PATCH | `/api/admin/users/:id` | admin | `{user, changed, changes?}` |
| GET | `/api/admin/activity` | admin | `{activity, total, …}` |
| GET | `/api/admin/sessions` | admin | `{sessions, total, …}` |
| GET | `/api/admin/sessions/:id` | admin | `{session, user, messages}` |
| GET | `/api/admin/files` | admin | `{files, total, …}` |
| GET | `/api/admin/files/:id/url` | admin | `{url, expiresAt, mimeType, audited}` |
| GET | `/api/admin/files/:id/text` | admin | `{preview, chars, pages, source, status}` |

`POST /api/chat` body — the one call that does all three modes:

```
send        { sessionId?, content, attachments?: string[], model? }
edit        { sessionId, content, replaceFromMessageId }
regenerate  { sessionId, regenerate: true }
```

A leftover `messages: [...]` array is rejected as `type: 'legacy_client'`.

---

## PHASE 2 (tail) — mount the gate

Four files. After these the app compiles again; right now `App.tsx` still calls
the deleted `streamChat(messages, signal)` signature, so **nothing builds until
this section is done**.

### 2.1 `src/main.tsx`

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthProvider } from './lib/auth'      // no .tsx
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
)
```

**Trap:** `AuthProvider` must be *outside* `App`, because `App` calls `useAuth()`
to decide what to render.

### 2.2 `src/App.tsx` — becomes a thin gate only

Delete the entire chat body (it moves to `ChatApp.tsx`). New file in full:

```tsx
import { useTheme } from './lib/theme'
import { useAuth } from './lib/auth'
import { LoginScreen } from './components/LoginScreen'
import { ChatApp } from './ChatApp'
import { Logo } from './components/Logo'

export default function App() {
  const { theme, toggleTheme } = useTheme()   // ABOVE the branch: themes the login screen too
  const { initialising, profile } = useAuth()

  if (initialising) return <Splash />
  if (!profile) return <LoginScreen theme={theme} onToggleTheme={toggleTheme} />
  return <ChatApp theme={theme} onToggleTheme={toggleTheme} />
}

function Splash() {
  return (
    <div className="flex h-full items-center justify-center bg-surface">
      <Logo size={40} />        {/* no spinner text: this is usually <200ms */}
    </div>
  )
}
```

**Traps**
- Every hook must sit above the three `return`s. Never `if (!profile) return`
  then `useState` below it.
- `useTheme()` before the branch, or signing out drops you to a light-mode login
  screen from a dark-mode app.
- The chat UI genuinely does not mount while signed out — that is the point of
  returning `<LoginScreen>` instead of overlaying it.

### 2.3 `.env.local.example`

```
# Public Firebase identifiers. NOT secrets — they ship in the JS bundle by
# design (see DOCS.md). Do not move them server-side.
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=            # optional; defaults to <projectId>.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_APP_ID=
VITE_FIREBASE_MESSAGING_SENDER_ID=    # optional
```

`FIREBASE_PROJECT_ID` in `wrangler.jsonc` must equal `VITE_FIREBASE_PROJECT_ID`,
or every sign-in ends in a 401 `invalid_token` (`auth.tsx` already prints exactly
that remedy).

### 2.4 `src/ChatApp.tsx` — skeleton now, filled in by Phase 3

Signature and header only in this phase:

```tsx
export function ChatApp({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  // ...Phase 3 state...
  return (
    <div className="flex h-full">
      <Sidebar ... />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-line px-3 py-2">
          <button onClick={() => setSidebarOpen(true)} className="lg:hidden">…</button>
          <ModelBadge />                            {/* optional */}
          <div className="flex items-center gap-1">
            <button onClick={onToggleTheme}>{theme === 'dark' ? <Sun/> : <Moon/>}</button>
            <UserMenu onOpenAdmin={isAdmin ? () => navigate('/admin') : undefined} />
          </div>
        </header>
        <ChatArea ... />
        <Composer ... />
      </div>
    </div>
  )
}
```

`onOpenAdmin` stays `undefined` until Phase 5 exists — `UserMenu` already hides
the item when it is missing.

---

## PHASE 3 — chat on the server (all inside `ChatApp.tsx`)

The worker half is done. This is entirely client state work.

### 3.1 State shape

```ts
const [conversations, setConversations] = useState<Conversation[]>([])   // sidebar rows
const [activeId, setActiveId] = useState<string | null>(null)
const [loadingList, setLoadingList] = useState(true)
const [loadingTranscript, setLoadingTranscript] = useState(false)
const [streaming, setStreaming] = useState(false)
const [error, setError] = useState<string | null>(null)
const [sidebarOpen, setSidebarOpen] = useState(false)

const abortRef = useRef<AbortController | null>(null)
const loadedRef = useRef<Set<string>>(new Set())   // session ids whose transcript is cached
const latest = useRef({ conversations, activeId })  // keep the existing memo() trick
useEffect(() => { latest.current = { conversations, activeId } }, [conversations, activeId])
```

`Conversation` (`src/types.ts`) is reused unchanged: `{id, title, messages,
createdAt, updatedAt}`. `Sidebar` only reads `id`/`title`/`updatedAt`, so a
`SessionSummary` maps in with `messages: []` and nothing breaks.

```ts
function toConversation(s: SessionSummary): Conversation {
  return { id: s.id, title: s.title, messages: [], createdAt: s.createdAt, updatedAt: s.updatedAt }
}
```

Helper used everywhere below:

```ts
function patchConversation(id: string, fn: (c: Conversation) => Conversation) {
  setConversations((prev) => prev.map((c) => (c.id === id ? fn(c) : c)))
}
function setMessages(id: string, fn: (m: Message[]) => Message[]) {
  patchConversation(id, (c) => ({ ...c, messages: fn(c.messages) }))
}
```

### 3.2 Load the list on mount

```ts
useEffect(() => {
  let cancelled = false
  ;(async () => {
    try {
      const res = await listSessions(100)
      if (cancelled) return
      setConversations(res.sessions.map(toConversation))
      // Do NOT auto-select: an empty ChatArea shows the welcome/suggestions state.
    } catch (err) {
      if (!cancelled) setError(errorText(err))
    } finally {
      if (!cancelled) setLoadingList(false)
    }
  })()
  return () => { cancelled = true }
}, [])
```

**Trap:** don't `void` the promise without a `cancelled` flag — StrictMode runs
this twice and the second unmount would otherwise `setState` after teardown.

### 3.3 Select a conversation → lazy transcript load

```ts
async function selectConversation(id: string) {
  setActiveId(id)
  setSidebarOpen(false)
  if (loadedRef.current.has(id)) return          // cached; no refetch
  setLoadingTranscript(true)
  try {
    const { session, messages } = await getTranscript(id)
    loadedRef.current.add(id)
    patchConversation(id, (c) => ({
      ...c,
      title: session.title,
      updatedAt: session.updatedAt,
      messages: messages.map(toMessage),
    }))
  } catch (err) {
    setError(errorText(err))
  } finally {
    setLoadingTranscript(false)
  }
}

function toMessage(m: TranscriptMessage): Message {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    error: m.error ?? undefined,
    // Phase 4 adds: attachments: m.attachments
  }
}
```

**Trap:** invalidate `loadedRef` for a session after every completed turn *or*
just keep appending locally (cheaper — do that). Never leave a stale cache that
omits the turn you just sent.

### 3.4 New chat

```ts
function newChat() {
  abortRef.current?.abort()
  setActiveId(null)         // no server call: the session is created on first send
  setSidebarOpen(false)
}
```

### 3.5 The one send path — `runTurn`

This is the heart of the phase. All three modes funnel through it.

```ts
type TurnInput =
  | { kind: 'send'; content: string; attachments?: string[] }
  | { kind: 'edit'; content: string; replaceFromMessageId: string }
  | { kind: 'regenerate' }

async function runTurn(input: TurnInput) {
  if (streaming) return
  setError(null)

  // ---- 1. Make sure a session exists BEFORE streaming -------------------
  // Pre-creating costs one ~30ms request and buys deterministic state: the
  // sidebar row never has to change its React key mid-stream. Safe for titles:
  // the worker's retitleStmt only fires when the title is still exactly
  // 'New chat', which is what POST /api/sessions leaves it as.
  let sessionId = latest.current.activeId
  if (!sessionId) {
    if (input.kind !== 'send') return                 // cannot edit/regen nothing
    const created = await createSession()
    sessionId = created.id
    setConversations((prev) => [toConversation(created), ...prev])
    loadedRef.current.add(created.id)                 // brand new: empty IS the transcript
    setActiveId(created.id)
  }
  const sid = sessionId

  // ---- 2. Optimistic local mutation ------------------------------------
  const assistantLocalId = newId()
  setMessages(sid, (prev) => {
    let next = prev
    if (input.kind === 'edit') {
      // Drop the edited message and everything after it — mirrors what the
      // worker does with replaceFromMessageId, so the two never disagree.
      const at = next.findIndex((m) => m.id === input.replaceFromMessageId)
      if (at >= 0) next = next.slice(0, at)
    }
    if (input.kind === 'regenerate') {
      // Drop only a trailing assistant message.
      if (next.length && next[next.length - 1].role === 'assistant') next = next.slice(0, -1)
    }
    if (input.kind !== 'regenerate') {
      next = [...next, { id: newId(), role: 'user', content: input.content, createdAt: Date.now() }]
    }
    return [...next, { id: assistantLocalId, role: 'assistant', content: '',
                       createdAt: Date.now(), streaming: true }]
  })

  // ---- 3. Stream --------------------------------------------------------
  const ctrl = new AbortController()
  abortRef.current = ctrl
  setStreaming(true)

  let acc = ''
  try {
    const req: ChatRequest =
      input.kind === 'regenerate'
        ? { sessionId: sid, regenerate: true }
        : input.kind === 'edit'
          ? { sessionId: sid, content: input.content, replaceFromMessageId: input.replaceFromMessageId }
          : { sessionId: sid, content: input.content, attachments: input.attachments }

    for await (const delta of streamChat(req, ctrl.signal, (meta) => {
      // Swap the placeholder id for the server's, so a later regenerate/edit
      // references a real row. Fires before the first token.
      if (meta.messageId) {
        setMessages(sid, (m) =>
          m.map((x) => (x.id === assistantLocalId ? { ...x, id: meta.messageId! } : x)))
      }
    })) {
      acc += delta
      setMessages(sid, (m) =>
        m.map((x) => (x.content === acc.slice(0, x.content.length) && x.streaming
          ? { ...x, content: acc } : x)))
      // Simpler and safer: track the target id in a local variable updated by
      // onMeta, and match on that id rather than on content.
    }
  } catch (err) {
    const msg = ctrl.signal.aborted ? undefined : errorText(err)
    if (msg) setError(msg)
    setMessages(sid, (m) => m.map((x) =>
      x.streaming ? { ...x, streaming: false, error: acc ? undefined : (msg ?? 'Stopped.') } : x))
    if (isRateLimit(err)) setError(`${msg} Try again shortly.`)
  } finally {
    setStreaming(false)
    abortRef.current = null
    setMessages(sid, (m) => m.map((x) => (x.streaming ? { ...x, streaming: false } : x)))
    // Sidebar freshness without a refetch:
    patchConversation(sid, (c) => ({ ...c, updatedAt: Date.now() }))
    void refreshTitleIfPlaceholder(sid)
  }
}
```

**Fix the delta accumulation properly** — the content-matching line above is
deliberately shown as the wrong-but-tempting version. Do this instead:

```ts
let targetId = assistantLocalId
// inside onMeta: if (meta.messageId) { targetId = meta.messageId; …swap id… }
// inside the loop:
acc += delta
setMessages(sid, (m) => m.map((x) => (x.id === targetId ? { ...x, content: acc } : x)))
```

`refreshTitleIfPlaceholder` — after the first turn the worker retitles the
session, and the client doesn't know the new title:

```ts
async function refreshTitleIfPlaceholder(sid: string) {
  const c = latest.current.conversations.find((x) => x.id === sid)
  if (!c || c.title !== 'New chat') return
  try {
    const res = await listSessions(1)             // cheapest way to read it back
    const fresh = res.sessions.find((s) => s.id === sid)
    if (fresh) patchConversation(sid, (x) => ({ ...x, title: fresh.title }))
  } catch { /* cosmetic only */ }
}
```

### 3.6 Stop, rename, delete

```ts
function stop() { abortRef.current?.abort() }

async function rename(id: string, title: string) {
  const previous = latest.current.conversations.find((c) => c.id === id)?.title ?? ''
  patchConversation(id, (c) => ({ ...c, title }))          // optimistic
  try { await renameSession(id, title) }
  catch (err) { patchConversation(id, (c) => ({ ...c, title: previous })); setError(errorText(err)) }
}

async function remove(id: string) {
  const snapshot = latest.current.conversations
  setConversations((prev) => prev.filter((c) => c.id !== id))
  if (latest.current.activeId === id) setActiveId(null)
  loadedRef.current.delete(id)
  try { await deleteSession(id) }
  catch (err) { setConversations(snapshot); setError(errorText(err)) }
}
```

### 3.7 One-time localStorage import

```ts
const importRef = useRef(false)

useEffect(() => {
  if (importRef.current) return          // StrictMode guard — NOT optional
  importRef.current = true
  if (localHistoryImported()) return
  const local = loadConversations()
  if (local.length === 0) { markLocalHistoryImported(); return }
  setImportPrompt(local)                 // show a banner; never import silently
}, [])

async function doImport(local: Conversation[]) {
  const payload = local
    .slice(0, 200)                                  // LIMITS.maxImportSessions
    .map((c) => ({
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messages: c.messages
        .slice(0, 400)                              // LIMITS.maxImportMessagesPerSession
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt })),
    }))
  try {
    const res = await importSessions(payload)
    markLocalHistoryImported()                      // only on success
    const list = await listSessions(100)
    setConversations(list.sessions.map(toConversation))
    setNotice(`Imported ${res.imported.sessions} conversations.`)
  } catch (err) {
    setError(errorText(err))                        // flag stays unset → retryable
  } finally {
    setImportPrompt(null)
  }
}
```

A "Not now" button just calls `markLocalHistoryImported()` so the prompt stops
nagging while the blob stays on disk.

**Trap:** don't strip the blob after import. `storage.ts` deliberately uses a
flag so a partial import is recoverable by hand.

### 3.8 Wire the existing components

```tsx
<Sidebar
  conversations={conversations}
  activeId={activeId}
  open={sidebarOpen}
  onClose={() => setSidebarOpen(false)}
  onNewChat={newChat}
  onSelect={selectConversation}      // now async — Sidebar ignores the promise, fine
  onRename={rename}
  onDelete={remove}
/>
<ChatArea
  conversation={conversations.find((c) => c.id === activeId) ?? undefined}
  streaming={streaming}
  onRegenerate={() => void runTurn({ kind: 'regenerate' })}
  onEditMessage={(id, content) => void runTurn({ kind: 'edit', content, replaceFromMessageId: id })}
  onSuggestion={(text) => void runTurn({ kind: 'send', content: text })}
/>
<Composer
  disabled={loadingTranscript}
  streaming={streaming}
  onSend={(text) => void runTurn({ kind: 'send', content: text })}
  onStop={stop}
/>
```

Check `ChatAreaProps`/`SidebarProps` for exact optionality before assuming
`conversation` accepts `undefined` vs `null`.

### 3.9 Phase 3 acceptance

- Send in a new chat → sidebar row appears immediately, gets a real title after
  the reply, `POST /api/chat` body contains no `messages` array.
- Reload the page → the conversation is still there (came from D1, not
  localStorage).
- Edit a mid-conversation message → everything after it disappears locally and
  the reloaded transcript agrees.
- Stop mid-stream → partial text is kept, no error box.
- Sign out and back in → same history.

---

## PHASE 4 — attachments

Worker side is done (`worker/routes/files.ts`, `lib/files/*`). Five new client
files plus small edits.

### 4.0 Prerequisite: expose a token to non-`fetch` callers

`lib/upload.ts` uses `XMLHttpRequest` (the only way to get upload progress), so
it cannot go through `apiFetch`. Add to `src/lib/apiClient.ts`:

```ts
/** For callers that cannot use fetch (XHR upload progress). */
export async function authToken(force = false): Promise<string> {
  if (!provider) throw new NotSignedInError()
  const token = await provider.getToken(force)
  if (!token) throw new NotSignedInError()
  return token
}
```

(`provider` is the module-scope object `configureApiClient` already stores.)

### 4.1 `src/lib/image.ts` — downscale before upload

```ts
const MAX_EDGE = 1568        // the largest edge any current vision model uses

export async function prepareImage(file: File, maxBytes: number): Promise<File> {
  if (!file.type.startsWith('image/')) return file
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) return file                                  // let the server judge it
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  if (scale === 1 && file.size <= maxBytes) return file      // nothing to gain

  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()

  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.85))
  if (!blob || blob.size >= file.size) return file           // re-encode made it worse
  return new File([blob], file.name.replace(/\.\w+$/, '') + '.webp', { type: 'image/webp' })
}
```

**Traps**
- Only `image/png`, `image/jpeg`, `image/webp`, `application/pdf` pass
  `worker/lib/files/detect.ts` — the magic-byte sniff, not the declared type.
  WebP output is accepted; GIF/HEIC/SVG are not, so don't offer them.
- `createImageBitmap` on a corrupt file throws — the `.catch(() => null)` is
  what lets the server produce the real error message.

### 4.2 `src/lib/pdfClient.ts` — extract text in the browser

`PDF_EXTRACT_MODE=client` is the live setting: Workers Free gives 10 ms CPU per
request, which is not enough to parse a PDF server-side.

```ts
import * as pdfjs from 'pdfjs-dist'
// Vite bundles the worker from the URL; do not hotlink a CDN (CSP forbids it).
pdfjs.GlobalWorkerOptions.workerSrc =
  new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

const MAX_PAGES = 50            // matches PDF_MAX_PAGES
const MAX_CHARS = 1_500_000     // under the worker's MAX_CLIENT_TEXT_CHARS = 2_000_000

export interface Extraction { text: string; pages: number }

export async function extractPdfText(file: File): Promise<Extraction | null> {
  try {
    const data = new Uint8Array(await file.arrayBuffer())
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise
    const pages = Math.min(doc.numPages, MAX_PAGES)
    const out: string[] = []
    let chars = 0
    for (let i = 1; i <= pages && chars < MAX_CHARS; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const text = content.items.map((it: any) => ('str' in it ? it.str : '')).join(' ')
      out.push(`\n\n--- Page ${i} ---\n${text}`)
      chars += text.length
      page.cleanup()
    }
    await doc.destroy()
    return { text: out.join('').slice(0, MAX_CHARS), pages }
  } catch {
    return null      // upload anyway; the file lands with processingStatus 'pending'
  }
}
```

**Trap:** returning `null` must not block the upload. A scanned PDF has no text
layer, and the UI's job is to say "text not extracted", not to refuse the file.

### 4.3 `src/lib/upload.ts` — XHR with progress

```ts
export interface UploadOptions {
  file: File
  sessionId?: string
  extraction?: Extraction | null
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export async function uploadFile(opts: UploadOptions): Promise<PublicFile> {
  return attempt(await authToken(), opts).catch(async (err) => {
    // One retry with a force-refreshed token — mirrors apiFetch's contract.
    if (err instanceof ApiError && err.status === 401) return attempt(await authToken(true), opts)
    throw err
  })
}

function attempt(token: string, o: UploadOptions): Promise<PublicFile> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('file', o.file)                                   // field name is 'file'
    if (o.sessionId) form.append('sessionId', o.sessionId)
    if (o.extraction) form.append('extraction', JSON.stringify(o.extraction))  // {text, pages}

    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/files')
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.responseType = 'text'
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) o.onProgress?.(e.loaded / e.total)
    }
    xhr.onload = () => {
      let body: any = null
      try { body = JSON.parse(xhr.responseText) } catch { /* non-JSON error page */ }
      if (xhr.status === 201 && body?.file) return resolve(body.file as PublicFile)
      reject(new ApiError(
        body?.error?.message ?? 'The upload failed.',
        xhr.status,
        body?.error?.type ?? 'upload_failed',
      ))
    }
    xhr.onerror = () => reject(new Error('The upload could not reach the server.'))
    xhr.ontimeout = () => reject(new Error('The upload timed out.'))
    o.signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(form)
  })
}
```

**Traps**
- Do **not** set `Content-Type` — the browser must add the multipart boundary.
- Check `ApiError`'s actual constructor argument order in `apiClient.ts` before
  calling it; match it exactly.
- The worker rejects on `content-length` before reading the body, so an
  oversized file fails fast with `type: 'file_too_large'`. Surface that message
  verbatim.

### 4.4 `src/lib/fileUrl.ts` — signed view URLs

`<img>` cannot send an `Authorization` header, hence the 300-second HMAC URL.

```ts
const cache = new Map<string, SignedViewUrl>()

export async function viewUrl(fileId: string): Promise<string> {
  const hit = cache.get(fileId)
  if (hit && hit.expiresAt - Date.now() > 30_000) return hit.url   // 30s safety margin
  const signed = await apiJson<SignedViewUrl>(`/api/files/${fileId}/url`)
  cache.set(fileId, signed)
  return signed.url            // already origin-relative: path + query
}

export function invalidateViewUrl(fileId: string) { cache.delete(fileId) }
```

In the image component, `onError` → `invalidateViewUrl(id)` → re-mint once, then
show a placeholder. An expired signature returns 401 `expired_signature`; one
silent re-mint is correct, a loop is not — cap it with a ref.

### 4.5 `src/components/AttachmentChip.tsx`

One pending-or-done attachment, in the composer tray or on a sent message.

```tsx
export interface PendingAttachment {
  localId: string
  file: File
  status: 'preparing' | 'uploading' | 'done' | 'failed'
  progress: number            // 0..1
  error?: string
  remote?: PublicFile         // set when status === 'done'
  controller?: AbortController
}

export function AttachmentChip({ item, onRemove }: { item: PendingAttachment; onRemove?: () => void }) {
  // image → <ImageThumb fileId={item.remote?.id} localFile={item.file} />
  //   Before upload finishes, show URL.createObjectURL(item.file) and
  //   revokeObjectURL on unmount — otherwise the blob leaks for the session.
  // pdf → FileText icon + filename + `${pages} pages` or "text not extracted"
  //   when remote.processingStatus !== 'done'.
  // status bar: a 2px progress line while 'uploading'; red border + message on 'failed'.
  // ✕ button calls onRemove (and item.controller?.abort() if still uploading).
}
```

Read `remote.filename` for display — it is the *original* name, not the R2 key.

### 4.6 `src/components/AttachmentTray.tsx`

```tsx
export function AttachmentTray({ items, onRemove }: {
  items: PendingAttachment[]
  onRemove: (localId: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 border-b border-line px-3 py-2">
      {items.map((it) => <AttachmentChip key={it.localId} item={it} onRemove={() => onRemove(it.localId)} />)}
    </div>
  )
}
```

### 4.7 `Composer.tsx` edits

New props (all optional so the component still type-checks alone):

```tsx
interface ComposerProps {
  disabled?: boolean
  streaming?: boolean
  onSend: (text: string, attachmentIds?: string[]) => void   // second arg is NEW
  onStop: () => void
  attachments?: PendingAttachment[]
  onAttach?: (files: File[]) => void
  onRemoveAttachment?: (localId: string) => void
  canAttachImages?: boolean       // from the active model's ModelSpec.vision
  canAttachDocuments?: boolean    // ModelSpec.documents
  maxAttachments?: number         // quota.maxAttachmentsPerMessage
}
```

Behaviour:

```tsx
const fileInputRef = useRef<HTMLInputElement>(null)
const accept = [
  canAttachImages && 'image/png,image/jpeg,image/webp',
  canAttachDocuments && 'application/pdf',
].filter(Boolean).join(',')

function submit() {
  const trimmed = text.trim()
  const ready = (attachments ?? []).filter((a) => a.status === 'done')
  const busy = (attachments ?? []).some((a) => a.status === 'uploading' || a.status === 'preparing')
  if (busy) return                                   // don't send half-uploaded context
  if (!trimmed && ready.length === 0) return         // text OR an attachment is enough
  if (streaming || disabled) return
  onSend(trimmed, ready.map((a) => a.remote!.id))
  setText('')
}
```

Plus: a paperclip button (`disabled` when `attachments.length >= maxAttachments`
or when neither capability is on, with a `title` explaining which), an
`onPaste` handler reading `e.clipboardData.files`, and drag-and-drop
(`onDragOver` preventDefault + `onDrop` reading `e.dataTransfer.files`).

**Trap:** the existing `submit()` returns early on empty text. That must relax to
"empty text *and* no attachments", or an image-only message is impossible.

### 4.8 `ChatApp.tsx` glue

```ts
const [pending, setPending] = useState<PendingAttachment[]>([])
const { quota, models, profile } = useAuth()
const activeModel = models.find((m) => m.default) ?? models[0]

async function attach(files: File[]) {
  const room = (quota?.maxAttachmentsPerMessage ?? 4) - pending.length
  if (room <= 0) { setError('That is the maximum number of attachments per message.'); return }

  for (const file of files.slice(0, room)) {
    const localId = newId()
    const controller = new AbortController()
    setPending((p) => [...p, { localId, file, status: 'preparing', progress: 0, controller }])
    try {
      const isPdf = file.type === 'application/pdf'
      const prepared = isPdf ? file : await prepareImage(file, quota?.maxImageBytes ?? 10_485_760)
      const extraction = isPdf ? await extractPdfText(prepared) : null

      update(localId, { status: 'uploading' })
      const remote = await uploadFile({
        file: prepared,
        sessionId: latest.current.activeId ?? undefined,   // may be null: that is allowed
        extraction,
        signal: controller.signal,
        onProgress: (f) => update(localId, { progress: f }),
      })
      update(localId, { status: 'done', progress: 1, remote })
    } catch (err) {
      update(localId, { status: 'failed', error: errorText(err) })
    }
  }
}

function update(localId: string, patch: Partial<PendingAttachment>) {
  setPending((p) => p.map((x) => (x.localId === localId ? { ...x, ...patch } : x)))
}

function removeAttachment(localId: string) {
  setPending((p) => {
    const hit = p.find((x) => x.localId === localId)
    hit?.controller?.abort()
    // Fire-and-forget cleanup so an abandoned upload doesn't sit in R2 for 24h.
    if (hit?.remote) void apiFetch(`/api/files/${hit.remote.id}`, { method: 'DELETE' }).catch(() => {})
    return p.filter((x) => x.localId !== localId)
  })
}
```

Then in `runTurn`, pass `attachments` through, and **clear the tray only after
the request is accepted** (i.e. after `onMeta` fires, not before the call) so a
failed send doesn't lose the uploads:

```ts
// inside onMeta, after recording ids:
setPending([])
```

`ChatArea`/`MessageItem` render attachments from `Message.attachments` (add the
optional field to `src/types.ts`: `attachments?: PublicFile[]`), reusing
`AttachmentChip` in a read-only mode.

### 4.9 `scripts/probe-vision.mjs`

Images are only sent as image parts if the upstream model actually accepts them.

```js
// Reads AGENTROUTER_API_KEY from .dev.vars WITHOUT printing it.
// Posts a 1x1 PNG data URL as an image_url content part to gpt-5.6-sol.
// Prints: "vision: yes" | "vision: no — <upstream message>".
// If no: leave ModelSpec.vision = false in worker/models.ts and the composer
// disables image attachment on its own. Do not flip the flag on a hunch.
```

Add `"probe:vision": "node scripts/probe-vision.mjs"`.

### 4.10 Phase 4 acceptance

- Drop a 4 MB photo → chip shows progress, thumbnail appears, `POST /api/files`
  returns 201, the stored file is ≤1568 px on its long edge.
- Attach a text PDF → `extractedChars > 0`, `extractionSource: 'client'`.
- Attach a scanned PDF → uploads, chip says text not extracted, chat still works.
- Attach 5 files with `MAX_ATTACHMENTS_PER_MESSAGE=4` → the 5th is refused
  client-side with a clear message.
- Reload a conversation with attachments → thumbnails re-render via freshly
  minted signed URLs.
- Let a URL expire (wait >5 min, then scroll it into view) → one silent re-mint,
  no broken image.

---

## PHASE 5 — admin panel (3 components)

### 5.1 `src/lib/router.ts`

Two routes only; a router dependency would be larger than this file.

```ts
export function useRoute() {
  const [path, setPath] = useState(() => window.location.pathname)
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    window.addEventListener('chatddb:navigate', onPop)
    return () => { window.removeEventListener('popstate', onPop)
                   window.removeEventListener('chatddb:navigate', onPop) }
  }, [])
  return path
}

export function navigate(to: string) {
  if (window.location.pathname === to) return
  window.history.pushState({}, '', to)
  window.dispatchEvent(new Event('chatddb:navigate'))
}
```

`App.tsx` gains one line after the auth gate:

```tsx
const path = useRoute()
if (path.startsWith('/admin')) {
  return profile.role === 'admin'
    ? <AdminPanel onExit={() => navigate('/')} />
    : <NotAllowed onExit={() => navigate('/')} />     // client-side courtesy only
}
```

**Trap:** this check is cosmetic. Authorisation lives in `requireAdmin` in the
worker; never treat the client branch as the control.

**Trap:** the worker serves the SPA for all non-`/api/*` paths, so a hard reload
of `/admin` works. Verify that once — if the asset handler 404s on unknown paths
it needs `not_found_handling: "single-page-application"`.

### 5.2 `src/lib/adminApi.ts`

Thin typed wrappers plus the response interfaces (mirror them into `apiTypes.ts`
style, sourced from `worker/routes/admin.ts`):

```ts
export const adminApi = {
  stats: () => apiJson<AdminStats>('/api/admin/stats'),
  users: (q: { search?: string; status?: string; role?: string; limit?: number; offset?: number }) =>
    apiJson<AdminUserList>(`/api/admin/users?${new URLSearchParams(clean(q))}`),
  user: (id: string) => apiJson<AdminUserDetail>(`/api/admin/users/${id}`),
  patchUser: (id: string, body: { status?: 'active' | 'suspended'; role?: 'user' | 'admin' }) =>
    apiJson<{ user: PublicUser; changed: boolean }>(`/api/admin/users/${id}`, { method: 'PATCH', json: body }),
  activity: (q: { userId?: string; action?: string; from?: number; to?: number; limit?: number; offset?: number }) =>
    apiJson<AdminActivityList>(`/api/admin/activity?${new URLSearchParams(clean(q))}`),
  sessions: (q: { userId?: string; limit?: number; offset?: number }) =>
    apiJson<AdminSessionList>(`/api/admin/sessions?${new URLSearchParams(clean(q))}`),
  session: (id: string) => apiJson<AdminTranscript>(`/api/admin/sessions/${id}`),
  files: (q: { userId?: string; limit?: number; offset?: number }) =>
    apiJson<AdminFileList>(`/api/admin/files?${new URLSearchParams(clean(q))}`),
  fileUrl: (id: string) => apiJson<SignedViewUrl & { audited: true }>(`/api/admin/files/${id}/url`),
  fileText: (id: string) => apiJson<AdminFileText>(`/api/admin/files/${id}/text`),
}
```

Shapes confirmed in the worker:
- stats → `{platform, storage, actions, generatedAt}`
- users[] → `PublicUser & {loginCount, counts:{sessions,messages,files}}`
- user detail → `{user: PublicUser & {loginCount}, usage, activity[], sessions[]}`
- activity[] → `PublicActivity & {user: {id,email,name} | null}`
- admin sessions[] → `PublicSession & {deletedAt, user:{id,email,name}}`
- transcript → `{session: PublicSession & {deletedAt}, user, messages[]}` (with tokens)
- files[] → `PublicFile & {sessionId, messageId, sha256, …}`

### 5.3 `src/components/admin/AdminPanel.tsx` — shell + overview

```tsx
type Tab = 'overview' | 'users' | 'inspect'

export function AdminPanel({ onExit }: { onExit: () => void }) {
  const [tab, setTab] = useState<Tab>('overview')
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { adminApi.stats().then(setStats).catch((e) => setError(errorText(e))) }, [])

  return (
    <div className="flex h-full flex-col bg-surface">
      <header>  ← Back to chat | ChatDDB admin | tab buttons </header>
      {error && <ErrorBar text={error} />}
      {tab === 'overview' && <Overview stats={stats} />}
      {tab === 'users' && <AdminUsers />}
      {tab === 'inspect' && <AdminInspector />}
    </div>
  )
}
```

`Overview` = stat cards (users total/active/suspended, messages today, sessions,
storage bytes formatted, orphaned-file count) plus the 14-day series as a bare
CSS bar chart. No chart library.

### 5.4 `src/components/admin/AdminUsers.tsx`

Table + inline detail. One component, two panes.

```tsx
// state: search (debounced 300ms), status/role filters, offset, rows, total,
//        selectedId, detail, busyId
// table columns: user (avatar+name+email), role, status, sessions, messages,
//                files, last login, actions
// actions: Suspend / Reactivate, Make admin / Remove admin
//   → window.confirm(...) first: these are privileged mutations
//   → adminApi.patchUser then patch the row in place from res.user
//   → on failure, revert and show the message
// clicking a row loads adminApi.user(id) into the detail pane: usage, recent
//   activity, that user's conversations (each opens the inspector)
```

**Trap:** never let an admin suspend or demote themselves — compare against
`useAuth().profile.id` and disable those buttons with a `title`. The worker
should refuse too; the UI shouldn't offer it.

### 5.5 `src/components/admin/AdminInspector.tsx`

Activity feed + conversations + transcript + files, one component with an
internal view switch.

```tsx
// view: 'activity' | 'sessions' | 'files' | 'transcript'
//
// activity: filters (userId, action, from/to as <input type=date>), paged rows,
//   metadata rendered as <pre>{JSON.stringify(m, null, 2)}</pre>.
//   Column shows the truncated IP HASH — label it "IP hash", never "IP".
//
// sessions: rows with owner, title, messageCount, updatedAt, deletedAt badge.
//   Click → adminApi.session(id) → transcript view.
//
// transcript: shows a standing notice —
//   "Opening this conversation was recorded as an admin access."
//   Render every message body as PLAIN TEXT:
//     <p className="whitespace-pre-wrap break-words">{m.content}</p>
//   NEVER the markdown renderer here. This is untrusted user content and the
//   admin view is the one place a stored-XSS or prompt-injection payload would
//   be read by a privileged account.
//
// files: rows with owner, filename, type, size, uploadStatus, processingStatus,
//   extractedChars/pages, extractionSource, sha256 (truncated).
//   "View" → adminApi.fileUrl(id) (audited server-side) → open in a new tab.
//   "Text" → adminApi.fileText(id) → 2,000-char preview in a <pre>.
```

**Trap:** the audit row is written by the worker *before* the private data is
returned. Don't add a client-side "preview" path that bypasses those endpoints.

### 5.6 Phase 5 acceptance

- A non-admin visiting `/admin` gets the refusal screen, and every
  `/api/admin/*` call returns 403 for them.
- Suspending a user makes their next request fail with 403 `account_suspended`,
  and the client signs them out (`apiClient` already handles that).
- Opening a transcript writes an `admin_chat_access` row visible in the activity
  feed; a signed file view writes `admin_file_access`.
- A message containing `<script>alert(1)</script>` or `# heading` renders as
  literal characters in the admin transcript.

---

## PHASE 6 — hardening

Rate limits, suspicious-activity heuristics and the CORS allowlist are already
in the worker. Two artefacts remain.

### 6.1 `public/_headers`

```
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Cross-Origin-Opener-Policy: same-origin-allow-popups
  Content-Security-Policy: default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'wasm-unsafe-eval' https://apis.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://lh3.googleusercontent.com; font-src 'self'; worker-src 'self' blob:; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com; frame-src https://accounts.google.com https://*.firebaseapp.com; form-action 'self'
```

Each non-obvious source, and what breaks without it:
- `'wasm-unsafe-eval'` + `worker-src blob:` — pdf.js.
- `img-src data: blob:` — the object-URL previews and the inline Google mark.
- `img-src …lh3.googleusercontent.com` — profile pictures.
- `connect-src identitytoolkit/securetoken` — Firebase token exchange and the
  hourly refresh. Without it sign-in dies after an hour, silently.
- `frame-src accounts.google.com + *.firebaseapp.com` — the popup/iframe flow.
- `Cross-Origin-Opener-Policy: same-origin-allow-popups` — plain `same-origin`
  breaks `signInWithPopup`.

**Traps**
- `style-src 'unsafe-inline'` is required while Tailwind emits inline styles and
  the components set `style={{width}}`. Tightening it needs nonces; note it as
  known debt rather than pretending it's clean.
- Verify `_headers` is actually applied — it must sit in `public/` so it lands at
  the root of `dist/`. Confirm with `curl -sI https://…/ | grep -i content-security`.
- Test sign-in **after** deploying this. A CSP that blocks Firebase looks exactly
  like a broken auth config.

### 6.2 `scripts/prune.mjs`

```js
// Usage: node scripts/prune.mjs [--remote] [--dry]
// Shells out to `wrangler d1 execute chatddb-f5-db --command "..."`.
// Deletes, in order:
//   1. activity_log rows older than ACTIVITY_RETENTION_DAYS (default 90)
//   2. rate_counters buckets older than 2 days
//   3. files with upload_status='pending' older than 24h  → prints their r2_keys
//      so they can be removed with `wrangler r2 object delete`
//   4. chat_sessions soft-deleted more than 30 days ago, and their messages
// Prints a per-table count. --dry runs the SELECT COUNT(*) form only.
// Default is --local; --remote must be explicit. Never destructive by accident.
```

Add `"db:prune": "node scripts/prune.mjs"` (the `package.json` entry that was
removed earlier for pointing at a non-existent file).

### 6.3 Phase 6 acceptance

- 21 messages in a minute with `RATE_CHAT_PER_MIN=20` → the 21st gets 429 with
  `Retry-After`, and the composer shows the wait rather than a generic failure.
- `curl -H 'Origin: https://evil.example' …/api/me` → no permissive CORS header.
- `node scripts/prune.mjs --dry` prints counts and changes nothing.

---

## PHASE 7 — documentation and smoke tests

### 7.1 `DOCS.md` (rewrite)

Sections, in order: architecture diagram (browser → Worker → D1/R2/AgentRouter,
Firebase off to the side for tokens only); **why there is no service-account key**
(JWKS verification with `jose`; the only auth config is the public
`FIREBASE_PROJECT_ID`); why `VITE_FIREBASE_*` are public and must not be hidden;
full env-var table (name, where it lives — `wrangler.jsonc` var vs secret vs
`.env.local` —, default, effect); the three secrets and how to set them
(`npm run secret`, `secret:files`, `secret:salt`); D1 schema summary; the file
pipeline including `PDF_EXTRACT_MODE=client` and *why* (10 ms CPU on Workers
Free); the API reference table from §0 above; admin panel and what each admin
action records; runbooks — *make someone an admin* (add to `ADMIN_EMAILS`, they
re-sign-in), *suspend a user*, *rotate the AgentRouter key*, *restore a
soft-deleted conversation*, *investigate a rate-limit complaint*; the Workers
Free ceilings that shaped the design.

### 7.2 `README.md`

Quick start only: prerequisites → `npm i` → create the Firebase project and
enable Google sign-in → copy `.env.local.example` → set `FIREBASE_PROJECT_ID`
and `ADMIN_EMAILS` in `wrangler.jsonc` → three secrets → `npm run db:migrate:local`
→ `npm run dev`. Then deploy: `npm run db:migrate` → `npm run deploy`. Link
`DOCS.md` and `public/privacy.html`.

### 7.3 Smoke scripts

All three take a Firebase ID token via `CHATDDB_TOKEN` (document how to get one:
DevTools → Application → IndexedDB → `firebaseLocalStorageDb`, or
`await firebase.auth().currentUser.getIdToken()` in the console). None of them
can mint a token, and that is fine — they are not CI gates.

```
scripts/smoke-auth.mjs
  GET  /api/health                 → 200, health.configured is TOP LEVEL
  GET  /api/me   (no token)        → 401, type 'no_session'   ← NEVER 404/502/503
  GET  /api/me   (bad token)       → 401, type 'invalid_token'
  GET  /api/me   (good token)      → 200, user/usage/quota/models/pdfExtractMode present
  POST /api/auth/session           → 200, {user}
  GET  /api/admin/stats (non-admin)→ 403

scripts/smoke-files.mjs
  POST /api/files  (1x1 PNG)               → 201, uploadStatus 'stored'
  POST /api/files  (a .txt renamed .png)   → 400, type 'unsupported_file_type'  ← magic bytes
  POST /api/files  (PDF + extraction JSON) → 201, extractionSource 'client'
  GET  /api/files/:id/url                  → 200, then GET the url → 200 + correct content-type
  GET  the url with sig tampered           → 401, type 'invalid_signature'
  DELETE /api/files/:id                    → 200; a second GET → 404

scripts/smoke-admin.mjs   (needs an admin token)
  GET /api/admin/stats     → 200, platform/storage/actions present
  GET /api/admin/users     → 200
  GET /api/admin/sessions/:id → 200, and an admin_chat_access row appears in
                              GET /api/admin/activity afterwards
```

Add `"smoke:auth"`, `"smoke:files"`, `"smoke:admin"` scripts.

### 7.4 Update the existing `smoke-backend.mjs`

`POST /api/chat` is now authenticated and takes the new body shape. Either send
`CHATDDB_TOKEN` and the `{content}` body, or skip the chat assertion when no
token is present — but keep the `health.configured` assertion exactly as it is.

---

## Recommended order, and what only you can do

Work in this order; each step leaves the tree building.

1. **Phase 2 tail** (§2.1–2.4) — then `npx tsc -b` and `npm run build`. Nothing
   has been type-checked since the new frontend files landed, so expect a first
   round of errors here, not later.
2. **Phase 3** (§3) — the app is fully usable at this point.
3. **Phase 4** (§4), in order: `apiClient.authToken` → `image.ts` → `pdfClient.ts`
   → `upload.ts` → `fileUrl.ts` → chips/tray → Composer → ChatApp glue.
4. **Phase 5** (§5) — router first, then `adminApi.ts`, then the three components.
5. **Phase 6** (§6) — deploy and re-test sign-in immediately after `_headers`.
6. **Phase 7** (§7).

Blocked on you, not on code:

- **Create the Firebase project**, enable Google sign-in, add your dev and
  deployed origins to the authorised-domains list, and fill in the four
  `VITE_FIREBASE_*` values in `.env.local` plus `FIREBASE_PROJECT_ID` in
  `wrangler.jsonc`. These must name the same project.
- **Put your email in `ADMIN_EMAILS`** in `wrangler.jsonc` before the first
  sign-in, or you get a `user` row and no way into the admin panel without a
  manual D1 update.
- **Create the two remaining secrets:** `npm run secret:files`
  (`FILE_URL_SECRET`) and `npm run secret:salt` (`IP_HASH_SALT`) for remote, plus
  matching lines *appended* to `.dev.vars` for local. Generate each with
  `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`.
  **Append only — do not rewrite `.dev.vars` or echo the AgentRouter key.**
- **Deployment stays your call.** Nothing here should be pushed live without you
  asking for it.
