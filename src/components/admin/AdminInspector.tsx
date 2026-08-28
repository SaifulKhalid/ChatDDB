import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  ExternalLink,
  Eye,
  FileCode,
  FileText,
  HardDrive,
  ImageIcon,
  Loader2,
  MessageSquare,
  Search,
  ShieldAlert,
  X,
} from 'lucide-react'
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

  // Offsets
  const [activityOffset, setActivityOffset] = useState(0)
  const [sessionOffset, setSessionOffset] = useState(0)
  const [fileOffset, setFileOffset] = useState(0)

  const loadActivity = useCallback((offset = 0) => {
    setBusy('activity')
    setError(null)
    setActivityOffset(offset)
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
    setBusy('sessions')
    setError(null)
    setSessionOffset(offset)
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
    setBusy('files')
    setError(null)
    setFileOffset(offset)
    adminApi.files({ userId: fileUserId || undefined, limit: LIMIT, offset })
      .then(setFiles)
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy((b) => (b === 'files' ? null : b)))
  }, [fileUserId])

  const loadTranscript = useCallback((id: string) => {
    setView('transcript')
    setTranscript(null)
    setBusy('transcript')
    setError(null)
    adminApi.session(id)
      .then(setTranscript)
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy((b) => (b === 'transcript' ? null : b)))
  }, [])

  const fetched = useRef<Set<View>>(new Set())
  useEffect(() => {
    if (view === 'transcript' || fetched.current.has(view)) return
    fetched.current.add(view)
    if (view === 'activity') loadActivity(0)
    if (view === 'sessions') loadSessions(0)
    if (view === 'files') loadFiles(0)
  }, [view, loadActivity, loadSessions, loadFiles])

  const opened = useRef<string | null>(null)
  useEffect(() => {
    if (!initialSessionId || opened.current === initialSessionId) return
    opened.current = initialSessionId
    loadTranscript(initialSessionId)
  }, [initialSessionId, loadTranscript])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface">
      {/* Subnav tabs */}
      <div className="flex items-center justify-between border-b border-line bg-surface-2/40 px-4 py-2.5">
        <div className="flex items-center gap-1">
          {(
            [
              { key: 'activity' as View, label: 'Audit Activity', icon: <Activity size={13} /> },
              { key: 'sessions' as View, label: 'Conversations', icon: <MessageSquare size={13} /> },
              { key: 'files' as View, label: 'Storage & Files', icon: <HardDrive size={13} /> },
            ] as const
          ).map((v) => (
            <button
              key={v.key}
              onClick={() => {
                setView(v.key)
                setError(null)
              }}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                view === v.key
                  ? 'bg-ink text-surface shadow-sm'
                  : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
              }`}
            >
              {v.icon}
              <span>{v.label}</span>
            </button>
          ))}
          {(view === 'transcript' || transcript) && (
            <button
              onClick={() => setView('transcript')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                view === 'transcript'
                  ? 'bg-ink text-surface shadow-sm'
                  : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
              }`}
            >
              <Eye size={13} />
              <span>Transcript</span>
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-xs text-red-500">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 md:p-6">
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

        {view === 'transcript' && (
          <TranscriptView
            data={transcript}
            loading={busy === 'transcript'}
            onBack={() => setView('sessions')}
          />
        )}
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-2">
      <Loader2 size={24} className="animate-spin text-ink-2" />
      <p className="text-xs text-ink-2">Loading data…</p>
    </div>
  )
}

function Pager({
  offset,
  total,
  onPage,
}: {
  offset: number
  total: number
  onPage: (offset: number) => void
}) {
  if (total <= LIMIT) return null
  return (
    <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-xs text-ink-2">
      <span>
        Showing {offset + 1}–{Math.min(offset + LIMIT, total)} of {total} records
      </span>
      <div className="flex items-center gap-2">
        <button
          disabled={offset === 0}
          onClick={() => onPage(Math.max(0, offset - LIMIT))}
          className="rounded-lg border border-line bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-surface-3 disabled:opacity-30"
        >
          Previous
        </button>
        <button
          disabled={offset + LIMIT >= total}
          onClick={() => onPage(offset + LIMIT)}
          className="rounded-lg border border-line bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-surface-3 disabled:opacity-30"
        >
          Next
        </button>
      </div>
    </div>
  )
}

const FILTER_INPUT =
  'rounded-xl border border-line bg-surface px-3 py-2 text-xs text-ink outline-none placeholder:text-ink-2 shadow-sm'
const SEARCH_BUTTON =
  'rounded-xl bg-ink px-4 py-2 text-xs font-medium text-surface hover:opacity-85 shadow-sm transition-opacity'

// ---- Sub-views -----------------------------------------------------------

// ---- Sub-views -----------------------------------------------------------

function ActivityView({
  data,
  loading,
  offset,
  userIdFilter,
  actionFilter,
  fromDate,
  toDate,
  onUserIdChange,
  onActionChange,
  onFromChange,
  onToChange,
  onSearch,
  onPage,
}: {
  data: AdminActivityList | null
  loading: boolean
  offset: number
  userIdFilter: string
  actionFilter: string
  fromDate: string
  toDate: string
  onUserIdChange: (v: string) => void
  onActionChange: (v: string) => void
  onFromChange: (v: string) => void
  onToChange: (v: string) => void
  onSearch: () => void
  onPage: (offset: number) => void
}) {
  const [expandedMetaId, setExpandedMetaId] = useState<string | null>(null)

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface-2/40 p-3">
        <input
          placeholder="Filter by User ID…"
          value={userIdFilter}
          onChange={(e) => onUserIdChange(e.target.value)}
          className={`min-w-[150px] flex-1 ${FILTER_INPUT}`}
        />
        <select
          value={actionFilter}
          onChange={(e) => onActionChange(e.target.value)}
          className={FILTER_INPUT}
        >
          <option value="">All Action Types</option>
          {(data?.actions ?? []).map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          <input
            type="date"
            aria-label="From date"
            value={fromDate}
            onChange={(e) => onFromChange(e.target.value)}
            className={FILTER_INPUT}
          />
          <span className="text-xs text-ink-2">to</span>
          <input
            type="date"
            aria-label="To date"
            value={toDate}
            onChange={(e) => onToChange(e.target.value)}
            className={FILTER_INPUT}
          />
        </div>
        <button onClick={onSearch} className={SEARCH_BUTTON}>
          Search Logs
        </button>
      </div>

      {loading ? (
        <Spinner />
      ) : !data || data.activity.length === 0 ? (
        <div className="rounded-2xl border border-line bg-surface p-12 text-center text-xs text-ink-2">
          No audit activity found matching the criteria.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-[11px] font-semibold text-ink-2">
                <th className="px-4 py-3 text-left">Timestamp</th>
                <th className="px-3 py-3 text-left">User</th>
                <th className="px-3 py-3 text-left">Action</th>
                <th className="px-3 py-3 text-left">IP Hash</th>
                <th className="px-4 py-3 text-left">Event Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.activity.map((row) => {
                const isExpanded = expandedMetaId === row.id
                return (
                  <tr key={row.id} className="transition-colors hover:bg-surface-2/60 align-top">
                    <td className="whitespace-nowrap px-4 py-3 text-[11px] text-ink-2 font-mono">
                      {new Date(row.timestamp).toLocaleString()}
                    </td>
                    <td className="px-3 py-3 font-medium text-ink">
                      {row.user?.email ? (
                        <div>
                          <p className="truncate max-w-[160px]">{row.user.email}</p>
                          <p className="font-mono text-[10px] text-ink-2 truncate max-w-[160px]">
                            {row.user.id}
                          </p>
                        </div>
                      ) : (
                        <span className="text-ink-2 italic">System / Anonymous</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`inline-flex items-center rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold ${
                          row.severity === 'alert'
                            ? 'bg-red-500/10 text-red-500 border border-red-500/20'
                            : row.severity === 'warn'
                              ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
                              : 'bg-surface-3 text-ink-2'
                        }`}
                      >
                        {row.action}
                      </span>
                    </td>
                    <td className="px-3 py-3 font-mono text-[10px] text-ink-2">
                      {row.ipHash ? (
                        <span className="rounded bg-surface-3 px-1.5 py-0.5">{row.ipHash}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {row.metadata != null ? (
                        <div>
                          <button
                            onClick={() => setExpandedMetaId(isExpanded ? null : row.id)}
                            className="rounded bg-surface-3 px-2 py-0.5 text-[10px] font-medium text-ink hover:bg-surface-2"
                          >
                            {isExpanded ? 'Collapse JSON' : 'View Payload'}
                          </button>
                          {isExpanded && (
                            <pre className="mt-2 max-h-48 overflow-auto rounded-xl border border-line bg-surface-2 p-2.5 font-mono text-[10px] text-ink-2">
                              {JSON.stringify(row.metadata, null, 2)}
                            </pre>
                          )}
                        </div>
                      ) : (
                        <span className="text-ink-2">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="px-4 pb-3">
            <Pager offset={offset} total={data.total} onPage={onPage} />
          </div>
        </div>
      )}
    </div>
  )
}

function SessionsView({
  data,
  loading,
  offset,
  userIdFilter,
  search,
  includeDeleted,
  onUserIdChange,
  onSearchChange,
  onIncludeDeletedChange,
  onSearch,
  onPage,
  onOpen,
}: {
  data: AdminSessionList | null
  loading: boolean
  offset: number
  userIdFilter: string
  search: string
  includeDeleted: boolean
  onUserIdChange: (v: string) => void
  onSearchChange: (v: string) => void
  onIncludeDeletedChange: (v: boolean) => void
  onSearch: () => void
  onPage: (offset: number) => void
  onOpen: (id: string) => void
}) {
  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface-2/40 p-3">
        <div className="flex flex-1 min-w-[200px] items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-xs shadow-sm">
          <Search size={14} className="text-ink-2" />
          <input
            placeholder="Search conversation title…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="flex-1 bg-transparent outline-none text-ink placeholder:text-ink-2"
          />
        </div>
        <input
          placeholder="Filter by User ID…"
          value={userIdFilter}
          onChange={(e) => onUserIdChange(e.target.value)}
          className={`min-w-[150px] ${FILTER_INPUT}`}
        />
        <label className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-xs text-ink-2 shadow-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => onIncludeDeletedChange(e.target.checked)}
            className="rounded text-accent"
          />
          <span>Include soft-deleted</span>
        </label>
        <button onClick={onSearch} className={SEARCH_BUTTON}>
          Search Chats
        </button>
      </div>

      {loading ? (
        <Spinner />
      ) : !data || data.sessions.length === 0 ? (
        <div className="rounded-2xl border border-line bg-surface p-12 text-center text-xs text-ink-2">
          No conversations found matching query.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-[11px] font-semibold text-ink-2">
                <th className="px-4 py-3 text-left">Conversation</th>
                <th className="px-3 py-3 text-left">User</th>
                <th className="px-3 py-3 text-right">Messages</th>
                <th className="px-3 py-3 text-left">Last Active</th>
                <th className="px-3 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.sessions.map((s) => (
                <tr key={s.id} className="transition-colors hover:bg-surface-2/60">
                  <td className="px-4 py-3 max-w-sm">
                    <p className="truncate font-semibold text-ink text-xs">{s.title}</p>
                    <p className="font-mono text-[10px] text-ink-2">{s.id}</p>
                  </td>
                  <td className="px-3 py-3 text-ink-2">
                    <p className="font-medium text-ink truncate max-w-[160px]">{s.user.email}</p>
                    <p className="font-mono text-[10px] text-ink-2 truncate max-w-[160px]">
                      {s.user.id}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-right font-medium text-ink tabular-nums">
                    {s.messageCount}
                  </td>
                  <td className="px-3 py-3 text-[11px] text-ink-2 whitespace-nowrap">
                    {new Date(s.updatedAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-3">
                    {s.deletedAt ? (
                      <span className="inline-flex rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-500">
                        Deleted
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                        Active
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => onOpen(s.id)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:border-accent hover:text-accent shadow-sm"
                    >
                      <Eye size={12} />
                      <span>Inspect</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-4 pb-3">
            <Pager offset={offset} total={data.total} onPage={onPage} />
          </div>
        </div>
      )}
    </div>
  )
}

function FilesView({
  data,
  loading,
  offset,
  userIdFilter,
  onUserIdChange,
  onSearch,
  onPage,
  onError,
}: {
  data: AdminFileList | null
  loading: boolean
  offset: number
  userIdFilter: string
  onUserIdChange: (v: string) => void
  onSearch: () => void
  onPage: (offset: number) => void
  onError: (message: string) => void
}) {
  const [fileText, setFileText] = useState<string | null>(null)
  const [loadingText, setLoadingText] = useState(false)

  async function viewFile(id: string) {
    try {
      const signed = await adminApi.fileUrl(id)
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
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface-2/40 p-3">
        <input
          placeholder="Filter by User ID…"
          value={userIdFilter}
          onChange={(e) => onUserIdChange(e.target.value)}
          className={`flex-1 ${FILTER_INPUT}`}
        />
        <button onClick={onSearch} className={SEARCH_BUTTON}>
          Search Files
        </button>
      </div>

      {loading ? (
        <Spinner />
      ) : !data || data.files.length === 0 ? (
        <div className="rounded-2xl border border-line bg-surface p-12 text-center text-xs text-ink-2">
          No files stored in R2 bucket match query.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-[11px] font-semibold text-ink-2">
                <th className="px-4 py-3 text-left">File</th>
                <th className="px-3 py-3 text-left">Owner</th>
                <th className="px-3 py-3 text-left">Type</th>
                <th className="px-3 py-3 text-right">Size</th>
                <th className="px-3 py-3 text-left">Status</th>
                <th className="px-3 py-3 text-left">Extraction</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.files.map((f) => (
                <tr key={f.id} className="transition-colors hover:bg-surface-2/60">
                  <td className="px-4 py-3 max-w-xs">
                    <div className="flex items-center gap-2">
                      <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-ink">
                        {f.type === 'image' ? <ImageIcon size={14} /> : <FileText size={14} />}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-ink" title={f.filename}>
                          {f.filename}
                        </p>
                        <p className="font-mono text-[10px] text-ink-2">{f.id}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-ink-2 truncate max-w-[160px]">
                    <p className="font-medium text-ink truncate">{f.user.email}</p>
                    <p className="font-mono text-[10px] text-ink-2 truncate">{f.user.id}</p>
                  </td>
                  <td className="px-3 py-3 font-mono uppercase text-[10px] text-ink-2">
                    {f.type}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums font-medium text-ink">
                    {formatBytes(f.size)}
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        f.uploadStatus === 'stored'
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : 'bg-surface-3 text-ink-2'
                      }`}
                    >
                      {f.uploadStatus}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-[11px] text-ink-2">
                    {f.extractedChars != null
                      ? `${f.extractedChars} chars / ${f.extractedPages ?? 0} pages`
                      : f.processingStatus}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1.5">
                      <button
                        onClick={() => void viewFile(f.id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-3"
                      >
                        <ExternalLink size={12} />
                        <span>View</span>
                      </button>
                      {f.type === 'pdf' && (
                        <button
                          onClick={() => void showText(f.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-3"
                        >
                          <FileCode size={12} />
                          <span>Text</span>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-4 pb-3">
            <Pager offset={offset} total={data.total} onPage={onPage} />
          </div>
        </div>
      )}

      {loadingText && <Spinner />}
      {fileText && (
        <div className="relative rounded-2xl border border-line bg-surface-2 p-4">
          <button
            onClick={() => setFileText(null)}
            className="absolute right-3 top-3 rounded-lg p-1 text-ink-2 hover:bg-surface-3 hover:text-ink"
          >
            <X size={14} />
          </button>
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-ink-2">
            {fileText}
          </pre>
        </div>
      )}
    </div>
  )
}

function TranscriptView({
  data,
  loading,
  onBack,
}: {
  data: AdminTranscript | null
  loading: boolean
  onBack: () => void
}) {
  if (loading) return <Spinner />
  if (!data)
    return (
      <div className="rounded-2xl border border-line bg-surface p-12 text-center text-xs text-ink-2">
        No conversation transcript loaded.
      </div>
    )

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      {/* Notice */}
      <div className="flex items-center justify-between rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-700 dark:text-amber-400">
        <div className="flex items-center gap-2">
          <ShieldAlert size={16} />
          <span>Opening this transcript was audited and logged server-side.</span>
        </div>
        <button
          onClick={onBack}
          className="rounded-lg border border-amber-500/30 bg-amber-500/20 px-2.5 py-1 font-medium hover:bg-amber-500/30"
        >
          Back to Conversations
        </button>
      </div>

      {/* Header */}
      <div className="rounded-2xl border border-line bg-surface-2 p-4">
        <h2 className="text-base font-bold text-ink">{data.session.title}</h2>
        <p className="mt-1 text-xs text-ink-2">
          User:{' '}
          <strong className="text-ink">
            {data.user?.name ?? data.user?.email ?? 'Deleted User'}
          </strong>{' '}
          ({data.user?.email ?? 'no email'}) · {data.messages.length} messages
          {data.session.deletedAt && (
            <span className="ml-2 rounded bg-red-500/10 px-1.5 py-0.5 text-red-500">
              Soft Deleted
            </span>
          )}
        </p>
      </div>

      {/* Message stream bubbles */}
      <div className="space-y-3">
        {data.messages.map((m) => (
          <div
            key={m.id}
            className={`rounded-2xl border p-4 ${
              m.role === 'user'
                ? 'border-line bg-surface-2/60 ml-8'
                : 'border-line bg-surface mr-8 shadow-sm'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-2">
                {m.role === 'user' ? '👤 User' : '🤖 Assistant'}
              </span>
              <span className="text-[10px] text-ink-2 font-mono">
                {new Date(m.createdAt).toLocaleString()}
              </span>
            </div>

            {/* Plain text for safety */}
            <p className="whitespace-pre-wrap break-words text-xs text-ink leading-relaxed">
              {m.content}
            </p>

            {m.attachments.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-line/60 pt-2">
                {m.attachments.map((a) => (
                  <span
                    key={a.id}
                    className="inline-flex items-center gap-1 rounded-lg bg-surface-3 px-2 py-1 text-[10px] text-ink"
                  >
                    <FileText size={10} />
                    {a.filename}
                  </span>
                ))}
              </div>
            )}

            {m.error && (
              <p className="mt-2 text-[11px] font-medium text-red-500">Error: {m.error}</p>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line/40 pt-2 text-[10px] text-ink-2 font-mono">
              {m.model && <span className="rounded bg-surface-3 px-1.5 py-0.5">{m.model}</span>}
              {m.tokens.total != null && (
                <span>
                  {m.tokens.total} tokens ({m.tokens.prompt ?? 0} prompt /{' '}
                  {m.tokens.completion ?? 0} completion)
                </span>
              )}
            </div>
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
