import { useEffect, useRef, useState } from 'react'
import { Moon, PanelLeft, Sun } from 'lucide-react'
import type { Conversation, Message } from './types'
import { newId } from './types'
import type { Theme } from './lib/theme'
import { useAuth } from './lib/auth'
import { apiFetch, errorText, isRateLimit } from './lib/apiClient'
import { type ChatRequest, streamChat, generateImage, listSessions, getTranscript, createSession, renameSession, deleteSession, importSessions } from './lib/api'
import { loadConversations, localHistoryImported, markLocalHistoryImported } from './lib/storage'
import type { PublicFile, SessionSummary, TranscriptMessage } from './lib/apiTypes'
import { prepareImage } from './lib/image'
import { uploadFile } from './lib/upload'
import type { PendingAttachment } from './components/AttachmentChip'
import { Sidebar } from './components/Sidebar'
import { ChatArea } from './components/ChatArea'
import { Composer } from './components/Composer'
import { UserMenu } from './components/UserMenu'
import { navigate } from './lib/router'

export function ChatApp({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const { quota, models, isAdmin, imageGeneration } = useAuth()
  const activeModel = models.find((m) => m.default) ?? models[0]

  // ---- 3.1 State shape ---------------------------------------------------
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [loadingTranscript, setLoadingTranscript] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia('(min-width: 768px)').matches)
  const [notice, setNotice] = useState<string | null>(null)
  const [importPrompt, setImportPrompt] = useState<Conversation[] | null>(null)
  const [pending, setPending] = useState<PendingAttachment[]>([])
  const [imageMode, setImageMode] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const loadedRef = useRef<Set<string>>(new Set())
  const latest = useRef({ conversations, activeId })
  useEffect(() => { latest.current = { conversations, activeId } }, [conversations, activeId])

  // Close sidebar when viewport crosses into mobile
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const onChange = (e: MediaQueryListEvent) => {
      if (!e.matches) setSidebarOpen(false)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  function toConversation(s: SessionSummary): Conversation {
    return {
      id: s.id,
      title: s.title,
      titleSource: s.titleSource,
      messages: [],
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }
  }

  function patchConversation(id: string, fn: (c: Conversation) => Conversation) {
    setConversations((prev) => prev.map((c) => (c.id === id ? fn(c) : c)))
  }

  function setMessages(id: string, fn: (m: Message[]) => Message[]) {
    patchConversation(id, (c) => ({ ...c, messages: fn(c.messages) }))
  }

  function toMessage(m: TranscriptMessage): Message {
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      error: m.error ?? undefined,
      attachments: m.attachments.length > 0 ? m.attachments : undefined,
    }
  }

  // -----------------------------------------------------------------------
  // 3.2 Load the list on mount
  // -----------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await listSessions(100)
        if (cancelled) return
        setConversations(res.sessions.map(toConversation))
      } catch (err) {
        if (!cancelled) setError(errorText(err))
      } finally {
        if (!cancelled) setLoadingList(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // -----------------------------------------------------------------------
  // 3.3 Select a conversation → lazy transcript load
  // -----------------------------------------------------------------------

  async function selectConversation(id: string) {
    setActiveId(id)
    setSidebarOpen(false)
    if (loadedRef.current.has(id)) return
    setLoadingTranscript(true)
    try {
      const { session, messages } = await getTranscript(id)
      loadedRef.current.add(id)
      patchConversation(id, (c) => ({
        ...c,
        title: session.title,
        titleSource: session.titleSource,
        updatedAt: session.updatedAt,
        messages: messages.map(toMessage),
      }))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoadingTranscript(false)
    }
  }

  // -----------------------------------------------------------------------
  // 3.4 New chat
  // -----------------------------------------------------------------------

  function newChat() {
    abortRef.current?.abort()
    setActiveId(null)
    setSidebarOpen(false)
  }

  // -----------------------------------------------------------------------
  // 3.5 The one send path — runTurn
  // -----------------------------------------------------------------------

  type TurnInput =
    | { kind: 'send'; content: string; attachments?: string[] }
    | { kind: 'edit'; content: string; replaceFromMessageId: string }
    | { kind: 'regenerate' }

  async function runTurn(input: TurnInput) {
    if (streaming) return
    setError(null)

    // ---- 1. Make sure a session exists BEFORE streaming -----------------
    let sessionId = latest.current.activeId
    if (!sessionId) {
      if (input.kind !== 'send') return
      // Every call site is `void runTurn(...)`, so a throw here would surface as
      // an unhandled rejection instead of a banner.
      try {
        const created = await createSession()
        sessionId = created.id
        setConversations((prev) => [toConversation(created), ...prev])
        loadedRef.current.add(created.id)
        setActiveId(created.id)
      } catch (err) {
        setError(errorText(err))
        return
      }
    }
    const sid = sessionId

    // ---- 2. Optimistic local mutation -----------------------------------
    // Resolved before the tray is cleared, so the sent message keeps its chips.
    const sentFiles: PublicFile[] =
      input.kind === 'send' && input.attachments?.length
        ? input.attachments
            .map((id) => pending.find((p) => p.remote?.id === id)?.remote)
            .filter((f): f is PublicFile => !!f)
        : []

    const assistantLocalId = newId()
    setMessages(sid, (prev) => {
      let next = prev
      if (input.kind === 'edit') {
        const at = next.findIndex((m) => m.id === input.replaceFromMessageId)
        if (at >= 0) next = next.slice(0, at)
      }
      if (input.kind === 'regenerate') {
        if (next.length && next[next.length - 1].role === 'assistant') next = next.slice(0, -1)
      }
      if (input.kind !== 'regenerate') {
        next = [...next, {
          id: newId(),
          role: 'user',
          content: input.content,
          createdAt: Date.now(),
          attachments: sentFiles.length > 0 ? sentFiles : undefined,
        }]
      }
      return [...next, { id: assistantLocalId, role: 'assistant', content: '', createdAt: Date.now(), streaming: true }]
    })

    // ---- 3. Stream -------------------------------------------------------
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setStreaming(true)

    let acc = ''
    let targetId = assistantLocalId

    try {
      const req: ChatRequest =
        input.kind === 'regenerate'
          ? { sessionId: sid, regenerate: true }
          : input.kind === 'edit'
            ? { sessionId: sid, content: input.content, replaceFromMessageId: input.replaceFromMessageId }
            : { sessionId: sid, content: input.content, attachments: input.attachments }

      for await (const delta of streamChat(req, ctrl.signal, (meta) => {
        if (meta.messageId) {
          targetId = meta.messageId
          setMessages(sid, (m) =>
            m.map((x) => (x.id === assistantLocalId ? { ...x, id: meta.messageId! } : x)))
        }
        // Only a `send` consumed the tray. Clearing it on edit/regenerate would
        // silently discard files the user had queued for their next message.
        if (input.kind === 'send') setPending([])
      })) {
        acc += delta
        setMessages(sid, (m) =>
          m.map((x) => (x.id === targetId ? { ...x, content: acc } : x)))
      }
    } catch (err) {
      const msg = ctrl.signal.aborted ? undefined : errorText(err)
      // A 429 is transient; say so, otherwise the message reads like a hard failure.
      if (msg) setError(isRateLimit(err) ? `${msg} Try again shortly.` : msg)
      setMessages(sid, (m) => m.map((x) =>
        x.streaming ? { ...x, streaming: false, error: acc ? undefined : (msg ?? 'Stopped.') } : x))
    } finally {
      setStreaming(false)
      abortRef.current = null
      setMessages(sid, (m) => m.map((x) => (x.streaming ? { ...x, streaming: false } : x)))
      patchConversation(sid, (c) => ({ ...c, updatedAt: Date.now() }))
      void refreshTitleIfPlaceholder(sid)
    }
  }

  // -----------------------------------------------------------------------
  // 3.5b The image path — runImageTurn
  // -----------------------------------------------------------------------

  /**
   * Generates an image and drops it into the conversation.
   *
   * A sibling of `runTurn` rather than a branch inside it: `POST /api/images`
   * returns one JSON object instead of a token stream, so there is no
   * accumulator, no meta callback, and no pacing. What it shares is the shape of
   * the optimistic update — user turn, then a placeholder assistant turn that is
   * replaced when the real ids arrive.
   *
   * `streaming` is reused for the busy state so the composer disables and the
   * Stop button appears. Stop aborts the *fetch*, not the generation: the
   * neurons are already committed by then, so the image still lands server-side
   * and will appear when the conversation is next loaded. Discarding it locally
   * while keeping it in the transcript is the honest outcome — it was paid for.
   */
  async function runImageTurn(prompt: string) {
    if (streaming) return
    setError(null)

    let sessionId = latest.current.activeId
    if (!sessionId) {
      try {
        const created = await createSession()
        sessionId = created.id
        setConversations((prev) => [toConversation(created), ...prev])
        loadedRef.current.add(created.id)
        setActiveId(created.id)
      } catch (err) {
        setError(errorText(err))
        return
      }
    }
    const sid = sessionId

    const assistantLocalId = newId()
    setMessages(sid, (prev) => [
      ...prev,
      { id: newId(), role: 'user', content: prompt, createdAt: Date.now() },
      { id: assistantLocalId, role: 'assistant', content: '', createdAt: Date.now(), streaming: true },
    ])

    const ctrl = new AbortController()
    abortRef.current = ctrl
    setStreaming(true)

    try {
      const res = await generateImage({ sessionId: sid, prompt }, ctrl.signal)
      setMessages(sid, (m) =>
        m.map((x) =>
          x.id === assistantLocalId
            ? {
                ...x,
                id: res.messageId,
                // Matches ASSISTANT_NOTE in worker/routes/images.ts. The image
                // beside it is the real answer.
                content: 'Here is the image you asked for.',
                attachments: [res.file],
                streaming: false,
              }
            : x,
        ),
      )
    } catch (err) {
      const msg = ctrl.signal.aborted ? undefined : errorText(err)
      if (msg) setError(isRateLimit(err) ? `${msg} Try again shortly.` : msg)
      setMessages(sid, (m) =>
        m.map((x) =>
          x.id === assistantLocalId
            ? { ...x, streaming: false, error: msg ?? 'Stopped.' }
            : x,
        ),
      )
    } finally {
      setStreaming(false)
      abortRef.current = null
      patchConversation(sid, (c) => ({ ...c, updatedAt: Date.now() }))
      void refreshTitleIfPlaceholder(sid)
    }
  }

  /**
   * Picks up the model-generated title after the first exchange.
   *
   * The Worker names a session in `waitUntil`, which by definition runs *after*
   * the stream closes — and naming costs an upstream call of its own. So a
   * single fetch on stream end almost always loses the race. This retries on a
   * widening delay instead, covering the titler's own 20s ceiling, and stops the
   * moment the title changes or the session stops being a placeholder.
   */
  const TITLE_POLL_DELAYS_MS = [1_200, 2_500, 5_000, 9_000, 15_000]

  async function refreshTitleIfPlaceholder(sid: string) {
    const before = latest.current.conversations.find((x) => x.id === sid)
    if (!before || before.titleSource !== 'placeholder') return

    for (const delay of TITLE_POLL_DELAYS_MS) {
      await new Promise((r) => setTimeout(r, delay))

      // Re-read each pass: the user may have renamed or deleted the chat while
      // we were waiting, and neither should be overwritten by a late arrival.
      const current = latest.current.conversations.find((x) => x.id === sid)
      if (!current || current.titleSource !== 'placeholder') return

      try {
        const res = await listSessions(20)
        const fresh = res.sessions.find((s) => s.id === sid)
        if (!fresh) return
        if (fresh.titleSource !== 'placeholder') {
          patchConversation(sid, (x) => ({
            ...x,
            title: fresh.title,
            titleSource: fresh.titleSource,
          }))
          return
        }
      } catch {
        /* cosmetic only — keep the placeholder and try again */
      }
    }
  }

  // -----------------------------------------------------------------------
  // 3.6 Stop, rename, delete
  // -----------------------------------------------------------------------

  function stop() { abortRef.current?.abort() }

  async function rename(id: string, title: string) {
    const previous = latest.current.conversations.find((c) => c.id === id)
    if (!previous) return
    // `titleSource` flips with the title: the server freezes it as `manual`, and
    // an in-flight title poll must see that immediately rather than after the
    // round-trip, or it could still overwrite the name being typed.
    patchConversation(id, (c) => ({ ...c, title, titleSource: 'manual' }))
    try { await renameSession(id, title) }
    catch (err) {
      patchConversation(id, (c) => ({
        ...c,
        title: previous.title,
        titleSource: previous.titleSource,
      }))
      setError(errorText(err))
    }
  }

  async function remove(id: string) {
    const snapshot = latest.current.conversations
    setConversations((prev) => prev.filter((c) => c.id !== id))
    if (latest.current.activeId === id) setActiveId(null)
    loadedRef.current.delete(id)
    try { await deleteSession(id) }
    catch (err) { setConversations(snapshot); setError(errorText(err)) }
  }

  // -----------------------------------------------------------------------
  // 3.7 One-time localStorage import
  // -----------------------------------------------------------------------

  const importRef = useRef(false)

  useEffect(() => {
    if (importRef.current) return
    importRef.current = true
    if (localHistoryImported()) return
    const local = loadConversations()
    if (local.length === 0) { markLocalHistoryImported(); return }
    setImportPrompt(local)
  }, [])

  async function doImport(local: Conversation[]) {
    const payload = local
      .slice(0, 200)
      .map((c) => ({
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messages: c.messages
          .slice(0, 400)
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt })),
      }))
    try {
      const res = await importSessions(payload)
      markLocalHistoryImported()
      const list = await listSessions(100)
      setConversations(list.sessions.map(toConversation))
      setNotice(`Imported ${res.imported.sessions} conversations.`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setImportPrompt(null)
    }
  }

  // -----------------------------------------------------------------------
  // 4.8 Attachment glue
  // -----------------------------------------------------------------------

  async function attach(files: File[]) {
    const max = quota?.maxAttachmentsPerMessage ?? 4
    const room = max - pending.length
    if (room <= 0) {
      setError(`You can attach at most ${max} file${max !== 1 ? 's' : ''} per message.`)
      return
    }
    // Refuse the overflow out loud — a silent `slice` looks like the picker
    // dropped files at random.
    if (files.length > room) {
      setError(`Only ${room} more file${room !== 1 ? 's' : ''} can be attached to this message (limit ${max}).`)
    }

    for (const file of files.slice(0, room)) {
      const localId = newId()
      const controller = new AbortController()
      setPending((p) => [...p, { localId, file, status: 'preparing', progress: 0, controller }])

      try {
        const isPdf = file.type === 'application/pdf'
        const prepared = isPdf ? file : await prepareImage(file, quota?.maxImageBytes ?? 10_485_760)
        // pdf.js is ~40% of the bundle and only a PDF upload needs it, so the
        // module is fetched on first use rather than on page load.
        const extraction = isPdf ? await (await import('./lib/pdfClient')).extractPdfText(prepared) : null

        updateAttachment(localId, { status: 'uploading' })
        const remote = await uploadFile({
          file: prepared,
          sessionId: latest.current.activeId ?? undefined,
          extraction,
          signal: controller.signal,
          onProgress: (f) => updateAttachment(localId, { progress: f }),
        })
        updateAttachment(localId, { status: 'done', progress: 1, remote })
      } catch (err) {
        updateAttachment(localId, { status: 'failed', error: errorText(err) })
      }
    }
  }

  function updateAttachment(localId: string, patch: Partial<PendingAttachment>) {
    setPending((p) => p.map((x) => (x.localId === localId ? { ...x, ...patch } : x)))
  }

  function removeAttachment(localId: string) {
    // Side effects stay OUT of the updater: React may invoke it more than once
    // (StrictMode in dev, re-entrant renders in prod), which would abort twice
    // and fire a duplicate DELETE.
    const hit = pending.find((x) => x.localId === localId)
    hit?.controller?.abort()
    if (hit?.remote) void apiFetch(`/api/files/${hit.remote.id}`, { method: 'DELETE' }).catch(() => {})
    setPending((p) => p.filter((x) => x.localId !== localId))
  }

  // -----------------------------------------------------------------------
  // 3.8 Wire the existing components
  // -----------------------------------------------------------------------

  const active = conversations.find((c) => c.id === activeId) ?? null

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        open={sidebarOpen}
        loading={loadingList}
        onClose={() => setSidebarOpen(false)}
        onNewChat={newChat}
        onSelect={selectConversation}
        onRename={rename}
        onDelete={remove}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="flex items-center justify-between border-b border-line px-3 py-2">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              className="rounded-lg p-2 text-ink-2 hover:bg-surface-3 hover:text-ink"
              aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
              title="Toggle sidebar"
            >
              <PanelLeft size={20} />
            </button>
            <h2 className="truncate px-1 text-base font-semibold lg:hidden">
              {active ? active.title : 'ChatDDB'}
              <span className="ml-1 text-xs font-normal text-accent">by LabDDB</span>
            </h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onToggleTheme}
              className="rounded-lg p-2 text-ink-2 hover:bg-surface-3 hover:text-ink"
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title="Toggle theme"
            >
              {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
            </button>
            <UserMenu onOpenAdmin={isAdmin ? () => navigate('/admin') : undefined} />
          </div>
        </header>

        {notice && (
          <div className="mx-3 mt-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent">
            {notice}
          </div>
        )}

        {importPrompt && (
          <div className="mx-3 mt-2 flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm">
            <span className="flex-1 text-ink-2">
              Import {importPrompt.length} conversation{importPrompt.length !== 1 ? 's' : ''} from your browser storage?
            </span>
            <button
              onClick={() => { void doImport(importPrompt) }}
              className="rounded-full bg-ink px-3.5 py-1.5 text-sm text-surface hover:opacity-80"
            >
              Import
            </button>
            <button
              onClick={() => { markLocalHistoryImported(); setImportPrompt(null) }}
              className="rounded-full border border-line px-3.5 py-1.5 text-sm text-ink-2 hover:bg-surface-3"
            >
              Not now
            </button>
          </div>
        )}

        {error && (
          <div className="mx-3 mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
            {error}
          </div>
        )}

        <ChatArea
          conversation={active}
          streaming={streaming}
          onRegenerate={() => void runTurn({ kind: 'regenerate' })}
          onEditMessage={(id, content) => void runTurn({ kind: 'edit', content, replaceFromMessageId: id })}
          onSuggestion={(text) => void runTurn({ kind: 'send', content: text })}
        />

        <Composer
          disabled={loadingTranscript}
          streaming={streaming}
          onSend={(text, attachmentIds) =>
            imageMode
              ? void runImageTurn(text)
              : void runTurn({ kind: 'send', content: text, attachments: attachmentIds })
          }
          onStop={stop}
          attachments={pending}
          onAttach={(files) => void attach(files)}
          onRemoveAttachment={removeAttachment}
          canAttachImages={activeModel?.vision}
          canAttachDocuments={activeModel?.documents}
          maxAttachments={quota?.maxAttachmentsPerMessage}
          canGenerateImages={imageGeneration}
          imageMode={imageMode}
          onToggleImageMode={() => setImageMode((v) => !v)}
        />
      </div>
    </div>
  )
}
