import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  adminApi,
  type AdminActivityList,
  type AdminSessionList,
  type AdminFileList,
  type AdminTranscript,
} from '../../lib/adminApi'
import { errorText } from '../../lib/apiClient'

type View = 'activity' | 'sessions' | 'files' | 'transcript'

const LIMIT = 50
const DAY_MS = 86_400_000

/**
 * `<input type="date">` yields `YYYY-MM-DD`, which `Date.parse` reads as UTC
 * midnight. Passing that straight through as `to` would exclude the whole day the
 * user picked, so the end of the range is pushed to the last millisecond of it.
 */
function dateToMs(value: string, edge: 'start' | 'end'): number | undefined {
  if (!value) return undefined
  const ms = new Date(`${value}T00:00:00Z`).getTime()
  if (!Number.isFinite(ms)) return undefined
  return edge === 'start' ? ms : ms + DAY_MS - 1
}

export function AdminInspector({ initialSessionId }: { initialSessionId?: string | null }) {
  const [view, setView] = useState<View>(initialSessionId ? 'transcript' : 'activity')
  const [activity, setActivity] = useState<AdminActivityList | null>(null)
  const [sessions, setSessions] = useState<AdminSessionList | null>(null)
  const [files, setFiles] = useState<AdminFileList | null>(null)
  const [transcript, setTranscript] = useState<AdminTranscript | null>(null)
  const [busy, setBusy] = useState<View | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [userIdFilter, setUserIdFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [sessionUserId, setSessionUserId] = useState('')
  const [sessionSearch, setSessionSearch] = useState('')
  const [includeDeleted, setIncludeDeleted] = useState(false)
  const [fileUserId, setFileUserId] = useState('')

  // Offsets, one per paged view
  const [activityOffset, setActivityOffset] = useState(0)
  const [sessionOffset, setSessionOffset] = useState(0)
  const [fileOffset, setFileOffset] = useState(0)

  const loadActivity = useCallback((offset = 0) => {
    setBusy('activity'); setError(null); setActivityOffset(offset)
    adminApi.activity({
      userId: userIdFilter || undefined,
      action: actionFilter || undefined,
      from: dateToMs(fromDate, 'start'),
      to: dateToMs(toDate, 'end'),
      limit: LIMIT,
      offset,
    })
      .then(setActivity)
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy((b) => (b === 'activity' ? null : b)))
  }, [userIdFilter, actionFilter, fromDate, toDate])

  const loadSessions = useCallback((offset = 0) => {
    setBusy('sessions'); setError(null); setSessionOffset(offset)
    adminApi.sessions({
      userId: sessionUserId || undefined,
      search: sessionSearch || undefined,
      includeDeleted,
      limit: LIMIT,
      offset,
    })
      .then(setSessions)
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy((b) => (b === 'sessions' ? null : b)))
  }, [sessionUserId, sessionSearch, includeDeleted])

  const loadFiles = useCallback((offset = 0) => {
    setBusy('files'); setError(null); setFileOffset(offset)
    adminApi.files({ userId: fileUserId || undefined, limit: LIMIT, offset })
      .then(setFiles)
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy((b) => (b === 'files' ? null : b)))
  }, [fileUserId])

  const loadTranscript = useCallback((id: string) => {
    setView('transcript')
    setTranscript(null)
    setBusy('transcript'); setError(null)
    adminApi.session(id)
      .then(setTranscript)
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy((b) => (b === 'transcript' ? null : b)))
  }, [])

  // Fetch on first arrival at each tab. Without this the pane renders empty
  // until the user thinks to press Search.
  const fetched = useRef<Set<View>>(new Set())
  useEffect(() => {
    if (view === 'transcript' || fetched.current.has(view)) return
    fetched.current.add(view)
    if (view === 'activity') loadActivity(0)
    if (view === 'sessions') loadSessions(0)
    if (view === 'files') loadFiles(0)
  }, [view, loadActivity, loadSessions, loadFiles])

  // Deep link from the Users tab. Tracks the id rather than a boolean so that
  // clicking a second conversation over there re-opens rather than no-ops.
  const opened = useRef<string | null>(null)
  useEffect(() => {
    if (!initialSessionId || opened.current === initialSessionId) return
    opened.current = initialSessionId
    loadTranscript(initialSessionId)
  }, [initialSessionId, loadTranscript])

  // ---- Render -----------------------------------------------------------
  return (
    <div className="flex h-full flex-col">
      {/* View tabs */}
      <div className="flex gap-1 border-b border-line px-4 py-2">
        {([
          { key: 'activity' as View, label: 'Activity' },
          { key: 'sessions' as View, label: 'Conversations' },
          { key: 'files' as View, label: 'Files' },
        ]).map((v) => (
          <button
            key={v.key}
            onClick={() => { setView(v.key); setError(null) }}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
              view === v.key ? 'bg-ink text-surface' : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
            }`}
          >
            {v.label}
          </button>
        ))}
        {(view === 'transcript' || transcript) && (
          <button
            onClick={() => setView('transcript')}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
              view === 'transcript' ? 'bg-ink text-surface' : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
            }`}
          >
            Transcript
          </button>
        )}
      </div>

      {error && (
        <div className="mx-4 mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {view === 'activity' && (
          <ActivityView
            data={activity}
            loading={busy === 'activity'}
            offset={activityOffset}
            userIdFilter={userIdFilter}
            actionFilter={actionFilter}
            fromDate={fromDate}
            toDate={toDate}
            onUserIdChange={setUserIdFilter}
            onActionChange={setActionFilter}
            onFromChange={setFromDate}
            onToChange={setToDate}
            onSearch={() => loadActivity(0)}
            onPage={loadActivity}
          />
        )}

        {view === 'sessions' && (
          <SessionsView
            data={sessions}
            loading={busy === 'sessions'}
            offset={sessionOffset}
            userIdFilter={sessionUserId}
            search={sessionSearch}
            includeDeleted={includeDeleted}
            onUserIdChange={setSessionUserId}
            onSearchChange={setSessionSearch}
            onIncludeDeletedChange={setIncludeDeleted}
            onSearch={() => loadSessions(0)}
            onPage={loadSessions}
            onOpen={loadTranscript}
          />
        )}

        {view === 'files' && (
          <FilesView
            data={files}
            loading={busy === 'files'}
            offset={fileOffset}
            userIdFilter={fileUserId}
            onUserIdChange={setFileUserId}
            onSearch={() => loadFiles(0)}
            onPage={loadFiles}
            onError={setError}
          />
        )}

        {view === 'transcript' && <TranscriptView data={transcript} loading={busy === 'transcript'} />}
      </div>
    </div>
  )
}

// ---- Shared bits ---------------------------------------------------------

function Spinner() {
  return <div className="flex items-center justify-center py-8"><Loader2 size={20} className="animate-spin text-ink-2" /></div>
}

function Pager({
  offset, total, onPage,
}: { offset: number; total: number; onPage: (offset: number) => void }) {
  if (total <= LIMIT) return null
  return (
    <div className="mt-3 flex items-center justify-between text-xs text-ink-2">
      <span>
        {offset + 1}–{Math.min(offset + LIMIT, total)} of {total}
      </span>
      <div className="flex gap-2">
        <button
          disabled={offset === 0}
          onClick={() => onPage(Math.max(0, offset - LIMIT))}
          className="rounded px-2 py-1 hover:bg-surface-3 disabled:opacity-30"
        >
          Previous
        </button>
        <button
          disabled={offset + LIMIT >= total}
          onClick={() => onPage(offset + LIMIT)}
          className="rounded px-2 py-1 hover:bg-surface-3 disabled:opacity-30"
        >
          Next
        </button>
      </div>
    </div>
  )
}

const FILTER_INPUT =
  'rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs text-ink outline-none placeholder:text-ink-2'
const SEARCH_BUTTON = 'rounded-lg bg-ink px-3 py-1.5 text-xs text-surface hover:opacity-80'

// ---- Sub-views -----------------------------------------------------------

function ActivityView({
  data, loading, offset, userIdFilter, actionFilter, fromDate, toDate,
  onUserIdChange, onActionChange, onFromChange, onToChange, onSearch, onPage,
}: {
  data: AdminActivityList | null; loading: boolean; offset: number
  userIdFilter: string; actionFilter: string; fromDate: string; toDate: string
  onUserIdChange: (v: string) => void; onActionChange: (v: string) => void
  onFromChange: (v: string) => void; onToChange: (v: string) => void
  onSearch: () => void; onPage: (offset: number) => void
}) {
  return (
    <div>
      {/* Filters */}
      <div className="mb-3 flex flex-wrap gap-2">
        <input placeholder="User ID" value={userIdFilter} onChange={(e) => onUserIdChange(e.target.value)}
          className={`min-w-32 flex-1 ${FILTER_INPUT}`} />
        {/* A select, not a text box: the Worker 400s on any action outside
            ACTIVITY_ACTIONS, and it ships the list in every response. */}
        <select value={actionFilter} onChange={(e) => onActionChange(e.target.value)} className={FILTER_INPUT}>
          <option value="">All actions</option>
          {(data?.actions ?? []).map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <input type="date" aria-label="From date" value={fromDate}
          onChange={(e) => onFromChange(e.target.value)} className={FILTER_INPUT} />
        <input type="date" aria-label="To date" value={toDate}
          onChange={(e) => onToChange(e.target.value)} className={FILTER_INPUT} />
        <button onClick={onSearch} className={SEARCH_BUTTON}>Search</button>
      </div>

      {loading ? <Spinner /> : !data ? null : data.activity.length === 0 ? (
        <p className="text-sm text-ink-2">No activity found.</p>
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-ink-2">
                <th className="px-2 py-1.5 text-left font-medium">Time</th>
                <th className="px-2 py-1.5 text-left font-medium">User</th>
                <th className="px-2 py-1.5 text-left font-medium">Action</th>
                <th className="px-2 py-1.5 text-left font-medium">IP hash</th>
                <th className="px-2 py-1.5 text-left font-medium">Metadata</th>
              </tr>
            </thead>
            <tbody>
              {data.activity.map((row) => (
                <tr key={row.id} className="border-t border-line align-top">
                  <td className="whitespace-nowrap px-2 py-1.5 text-xs text-ink-2">
                    {new Date(row.timestamp).toLocaleString()}
                  </td>
                  <td className="px-2 py-1.5 text-xs text-ink">{row.user?.email ?? '—'}</td>
                  <td className="px-2 py-1.5 text-xs">
                    <span className={`rounded px-1.5 py-0.5 font-mono text-xs ${
                      row.severity === 'alert'
                        ? 'bg-red-500/10 text-red-500'
                        : row.severity === 'warn'
                          ? 'bg-amber-500/10 text-amber-600'
                          : 'bg-surface-3'
                    }`}>
                      {row.action}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-xs text-ink-2">{row.ipHash ?? '—'}</td>
                  <td className="px-2 py-1.5">
                    {row.metadata != null ? (
                      <pre className="max-h-24 overflow-y-auto text-[11px] text-ink-2">
                        {JSON.stringify(row.metadata, null, 2)}
                      </pre>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager offset={offset} total={data.total} onPage={onPage} />
        </>
      )}
    </div>
  )
}

function SessionsView({
  data, loading, offset, userIdFilter, search, includeDeleted,
  onUserIdChange, onSearchChange, onIncludeDeletedChange, onSearch, onPage, onOpen,
}: {
  data: AdminSessionList | null; loading: boolean; offset: number
  userIdFilter: string; search: string; includeDeleted: boolean
  onUserIdChange: (v: string) => void; onSearchChange: (v: string) => void
  onIncludeDeletedChange: (v: boolean) => void
  onSearch: () => void; onPage: (offset: number) => void; onOpen: (id: string) => void
}) {
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input placeholder="Title contains…" value={search} onChange={(e) => onSearchChange(e.target.value)}
          className={`min-w-32 flex-1 ${FILTER_INPUT}`} />
        <input placeholder="User ID" value={userIdFilter} onChange={(e) => onUserIdChange(e.target.value)}
          className={`min-w-32 flex-1 ${FILTER_INPUT}`} />
        <label className="flex items-center gap-1.5 text-xs text-ink-2">
          <input type="checkbox" checked={includeDeleted} onChange={(e) => onIncludeDeletedChange(e.target.checked)} />
          Include deleted
        </label>
        <button onClick={onSearch} className={SEARCH_BUTTON}>Search</button>
      </div>

      {loading ? <Spinner /> : !data ? null : data.sessions.length === 0 ? (
        <p className="text-sm text-ink-2">No conversations found.</p>
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-ink-2">
                <th className="px-2 py-1.5 text-left font-medium">Title</th>
                <th className="px-2 py-1.5 text-left font-medium">Owner</th>
                <th className="px-2 py-1.5 text-right font-medium">Messages</th>
                <th className="px-2 py-1.5 text-left font-medium">Updated</th>
                <th className="px-2 py-1.5 text-left font-medium">Deleted</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {data.sessions.map((s) => (
                <tr key={s.id} className="border-t border-line">
                  <td className="max-w-48 truncate px-2 py-1.5 text-sm text-ink" title={s.title}>{s.title}</td>
                  <td className="px-2 py-1.5 text-xs text-ink-2">{s.user.email}</td>
                  <td className="px-2 py-1.5 text-right text-xs text-ink-2">{s.messageCount}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-xs text-ink-2">
                    {new Date(s.updatedAt).toLocaleDateString()}
                  </td>
                  <td className="px-2 py-1.5 text-xs">
                    {s.deletedAt ? (
                      <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-xs text-red-500">Yes</span>
                    ) : '—'}
                  </td>
                  <td className="px-2 py-1.5">
                    <button onClick={() => onOpen(s.id)}
                      className="rounded px-2 py-1 text-xs text-ink-2 hover:bg-surface-3 hover:text-ink">Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager offset={offset} total={data.total} onPage={onPage} />
        </>
      )}
    </div>
  )
}

function FilesView({
  data, loading, offset, userIdFilter, onUserIdChange, onSearch, onPage, onError,
}: {
  data: AdminFileList | null; loading: boolean; offset: number
  userIdFilter: string; onUserIdChange: (v: string) => void
  onSearch: () => void; onPage: (offset: number) => void
  onError: (message: string) => void
}) {
  const [fileText, setFileText] = useState<string | null>(null)
  const [loadingText, setLoadingText] = useState(false)

  async function viewFile(id: string) {
    try {
      const signed = await adminApi.fileUrl(id)
      // `noopener` matters even same-origin: without it the new tab gets a live
      // `window.opener` handle back into the admin panel.
      window.open(signed.url, '_blank', 'noopener,noreferrer')
    } catch (e) {
      onError(errorText(e))
    }
  }

  async function showText(id: string) {
    setLoadingText(true)
    setFileText(null)
    try {
      const t = await adminApi.fileText(id)
      const header = `${t.source ?? 'no source'} • ${t.chars ?? 0} chars • ${t.pages ?? 0} pages • ${t.status}${
        t.truncated ? ' • preview truncated' : ''
      }`
      setFileText(`--- ${header} ---\n\n${t.preview ?? '(no text extracted)'}`)
    } catch (e) {
      setFileText(errorText(e))
    } finally {
      setLoadingText(false)
    }
  }

  return (
    <div>
      <div className="mb-3 flex gap-2">
        <input placeholder="User ID" value={userIdFilter} onChange={(e) => onUserIdChange(e.target.value)}
          className={`flex-1 ${FILTER_INPUT}`} />
        <button onClick={onSearch} className={SEARCH_BUTTON}>Search</button>
      </div>

      {loading ? <Spinner /> : !data ? null : data.files.length === 0 ? (
        <p className="text-sm text-ink-2">No files found.</p>
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-ink-2">
                <th className="px-2 py-1.5 text-left font-medium">Filename</th>
                <th className="px-2 py-1.5 text-left font-medium">Owner</th>
                <th className="px-2 py-1.5 text-left font-medium">Type</th>
                <th className="px-2 py-1.5 text-right font-medium">Size</th>
                <th className="px-2 py-1.5 text-left font-medium">Status</th>
                <th className="px-2 py-1.5 text-left font-medium">Extraction</th>
                <th className="px-2 py-1.5 text-left font-medium">SHA256</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {data.files.map((f) => (
                <tr key={f.id} className="border-t border-line">
                  <td className="max-w-32 truncate px-2 py-1.5 text-sm text-ink" title={f.filename}>{f.filename}</td>
                  <td className="px-2 py-1.5 text-xs text-ink-2" title={f.user.id}>{f.user.email}</td>
                  <td className="px-2 py-1.5 text-xs text-ink-2">{f.type}</td>
                  <td className="px-2 py-1.5 text-right text-xs text-ink-2">{formatBytes(f.size)}</td>
                  <td className="px-2 py-1.5 text-xs">
                    <span className={`rounded px-1.5 py-0.5 ${
                      f.uploadStatus === 'stored' ? 'bg-accent/10 text-accent' : 'text-ink-2'
                    }`}>{f.uploadStatus}</span>
                  </td>
                  <td className="px-2 py-1.5 text-xs text-ink-2">
                    {f.extractedChars != null
                      ? `${f.extractedChars}c / ${f.extractedPages ?? 0}p (${f.extractionSource ?? '—'})`
                      : f.processingStatus}
                  </td>
                  <td className="max-w-24 truncate px-2 py-1.5 font-mono text-xs text-ink-2" title={f.sha256}>
                    {f.sha256.slice(0, 16)}…
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex gap-1">
                      <button onClick={() => void viewFile(f.id)}
                        className="rounded px-2 py-1 text-xs text-ink-2 hover:bg-surface-3 hover:text-ink">View</button>
                      {f.type === 'pdf' && (
                        <button onClick={() => void showText(f.id)}
                          className="rounded px-2 py-1 text-xs text-ink-2 hover:bg-surface-3 hover:text-ink">Text</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager offset={offset} total={data.total} onPage={onPage} />

          {loadingText && <Spinner />}
          {fileText && (
            <pre className="mt-4 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-xl border border-line bg-surface-2 p-4 text-xs text-ink-2">
              {fileText}
            </pre>
          )}
        </>
      )}
    </div>
  )
}

function TranscriptView({ data, loading }: { data: AdminTranscript | null; loading: boolean }) {
  if (loading) return <Spinner />
  if (!data) return <p className="text-sm text-ink-2">No transcript loaded.</p>

  return (
    <div>
      <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-600">
        Opening this conversation was recorded as an admin access.
      </div>

      <div className="mb-4 text-sm">
        <p className="font-semibold text-ink">{data.session.title}</p>
        <p className="text-xs text-ink-2">
          {/* The owner row can be gone while a soft-deleted session survives. */}
          {data.user?.name ?? data.user?.email ?? 'Deleted user'} · {data.messages.length} messages
          {data.session.deletedAt && ' · soft-deleted'}
        </p>
      </div>

      <div className="space-y-4">
        {data.messages.map((m) => (
          <div key={m.id} className={`rounded-xl border border-line p-4 ${m.role === 'user' ? 'bg-bubble' : 'bg-surface-2'}`}>
            <p className="mb-1 text-xs font-medium text-ink-2">{m.role === 'user' ? 'User' : 'Assistant'}</p>
            {/* PLAIN TEXT, never the markdown renderer. This is untrusted user
                content being read by a privileged account. */}
            <p className="whitespace-pre-wrap break-words text-sm text-ink">{m.content}</p>
            {m.attachments.length > 0 && (
              <p className="mt-1.5 text-[11px] text-ink-2">
                {m.attachments.length} attachment{m.attachments.length !== 1 ? 's' : ''}:{' '}
                {m.attachments.map((a) => a.filename).join(', ')}
              </p>
            )}
            {m.error && <p className="mt-1 text-[11px] text-red-500">Error: {m.error}</p>}
            <p className="mt-1 text-[11px] text-ink-2">
              {new Date(m.createdAt).toLocaleString()}
              {m.model && ` · ${m.model}`}
              {m.tokens.total != null && ` · ${m.tokens.total} tokens (${m.tokens.source ?? 'unknown'})`}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
