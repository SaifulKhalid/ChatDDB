import { useEffect, useState } from 'react'
import {
  Activity,
  ChevronRight,
  Loader2,
  MessageSquare,
  Search,
  Shield,
  UserCheck,
  UserX,
  X,
} from 'lucide-react'
import { useAuth } from '../../lib/auth'
import { adminApi } from '../../lib/adminApi'
import { errorText } from '../../lib/apiClient'
import type { AdminUserRow, AdminUserDetail } from '../../lib/adminApi'

const LIMIT = 20

export function AdminUsers({ onOpenSession }: { onOpenSession?: (sessionId: string) => void }) {
  const { profile } = useAuth()
  const currentId = profile?.id

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [offset, setOffset] = useState(0)

  const [rows, setRows] = useState<AdminUserRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<AdminUserDetail | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Debounce search box
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    adminApi.users({
      search: debouncedSearch || undefined,
      status: statusFilter || undefined,
      role: roleFilter || undefined,
      limit: LIMIT,
      offset,
    })
      .then((res) => {
        if (!cancelled) {
          setRows(res.users)
          setTotal(res.total)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [debouncedSearch, statusFilter, roleFilter, offset])

  async function selectUser(id: string) {
    if (selectedId === id) {
      setSelectedId(null)
      setDetail(null)
      return
    }
    setSelectedId(id)
    setDetail(null)
    try {
      setDetail(await adminApi.user(id))
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function patchUser(
    id: string,
    body: { status?: 'active' | 'suspended'; role?: 'user' | 'admin' },
  ) {
    const label =
      body.status === 'suspended'
        ? 'suspend'
        : body.status === 'active'
          ? 'reactivate'
          : body.role === 'admin'
            ? 'grant admin to'
            : 'remove admin from'
    if (!window.confirm(`Are you sure you want to ${label} this user?`)) return

    setBusyId(id)
    setError(null)
    try {
      const res = await adminApi.patchUser(id, body)
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...res.user } : r)))
      setDetail((d) => (d && d.user.id === id ? { ...d, user: { ...d.user, ...res.user } } : d))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex h-full flex-col lg:flex-row overflow-hidden bg-surface">
      {/* Table pane */}
      <div className="flex min-w-0 flex-1 flex-col border-r border-line">
        {/* Filters bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 bg-surface-2/40">
          <div className="flex flex-1 min-w-[200px] items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm shadow-sm">
            <Search size={15} className="shrink-0 text-ink-2" />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setOffset(0)
              }}
              placeholder="Search users by email or display name…"
              className="flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-2"
            />
            {search && (
              <button
                onClick={() => {
                  setSearch('')
                  setOffset(0)
                }}
                className="text-ink-2 hover:text-ink"
              >
                <X size={13} />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value)
                setOffset(0)
              }}
              aria-label="Filter by status"
              className="rounded-xl border border-line bg-surface px-3 py-2 text-xs font-medium text-ink outline-none shadow-sm"
            >
              <option value="">All Statuses</option>
              <option value="active">Active Only</option>
              <option value="suspended">Suspended Only</option>
            </select>
            <select
              value={roleFilter}
              onChange={(e) => {
                setRoleFilter(e.target.value)
                setOffset(0)
              }}
              aria-label="Filter by role"
              className="rounded-xl border border-line bg-surface px-3 py-2 text-xs font-medium text-ink outline-none shadow-sm"
            >
              <option value="">All Roles</option>
              <option value="user">Standard Users</option>
              <option value="admin">Administrators</option>
            </select>
          </div>
        </div>

        {error && (
          <p className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-500">
            {error}
          </p>
        )}

        {/* Table */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-2">
              <Loader2 size={24} className="animate-spin text-ink-2" />
              <p className="text-xs text-ink-2">Loading user directory…</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-xs text-ink-2">
              No users match the search criteria.
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="sticky top-0 z-10 border-b border-line bg-surface-2 text-[11px] font-semibold text-ink-2">
                  <th className="px-4 py-2.5 text-left">User</th>
                  <th className="px-3 py-2.5 text-left">Role</th>
                  <th className="px-3 py-2.5 text-left">Status</th>
                  <th className="px-3 py-2.5 text-right">Chats</th>
                  <th className="px-3 py-2.5 text-right">Messages</th>
                  <th className="px-3 py-2.5 text-right">Files</th>
                  <th className="px-4 py-2.5 text-right">Last Login</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => void selectUser(row.id)}
                    className={`cursor-pointer transition-colors hover:bg-surface-2 ${
                      selectedId === row.id ? 'bg-surface-2 font-medium' : ''
                    }`}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-bold text-white shadow-sm">
                          {(row.name ?? row.email).charAt(0).toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium text-ink">{row.name ?? 'Anonymous'}</p>
                          <p className="truncate text-[11px] text-ink-2 font-mono">{row.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          row.role === 'admin'
                            ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400'
                            : 'bg-surface-3 text-ink-2'
                        }`}
                      >
                        {row.role === 'admin' && <Shield size={10} />}
                        {row.role}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          row.status === 'suspended'
                            ? 'bg-red-500/10 text-red-500'
                            : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        }`}
                      >
                        {row.status === 'suspended' ? <UserX size={10} /> : <UserCheck size={10} />}
                        {row.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-medium text-ink tabular-nums">
                      {row.counts.sessions}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink-2 tabular-nums">
                      {row.counts.messages}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink-2 tabular-nums">
                      {row.counts.files}
                    </td>
                    <td className="px-4 py-2.5 text-right text-[11px] text-ink-2 whitespace-nowrap">
                      {row.lastLogin ? new Date(row.lastLogin).toLocaleDateString() : 'Never'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {row.id !== currentId && busyId !== row.id && (
                        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                          {row.status === 'active' ? (
                            <button
                              onClick={() => void patchUser(row.id, { status: 'suspended' })}
                              className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] font-medium text-ink-2 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-500"
                              title="Suspend user access"
                            >
                              Suspend
                            </button>
                          ) : (
                            <button
                              onClick={() => void patchUser(row.id, { status: 'active' })}
                              className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] font-medium text-ink-2 hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-500"
                              title="Reactivate user access"
                            >
                              Reactivate
                            </button>
                          )}
                          {row.role === 'user' ? (
                            <button
                              onClick={() => void patchUser(row.id, { role: 'admin' })}
                              className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] font-medium text-ink-2 hover:border-purple-500/40 hover:bg-purple-500/10 hover:text-purple-500"
                              title="Grant admin privileges"
                            >
                              Promote
                            </button>
                          ) : (
                            <button
                              onClick={() => void patchUser(row.id, { role: 'user' })}
                              className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] font-medium text-ink-2 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-500"
                              title="Demote to standard user"
                            >
                              Demote
                            </button>
                          )}
                        </div>
                      )}
                      {row.id === currentId && (
                        <span className="text-[10px] text-ink-2 italic">You</span>
                      )}
                      {busyId === row.id && (
                        <Loader2 size={13} className="animate-spin text-ink-2 ml-auto" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination Bar */}
        <div className="flex items-center justify-between border-t border-line bg-surface-2/40 px-4 py-2.5 text-xs text-ink-2">
          <span>
            {total === 0 ? '0 users' : `${offset + 1}–${Math.min(offset + LIMIT, total)} of ${total} users`}
          </span>
          <div className="flex items-center gap-2">
            <button
              disabled={offset === 0 || loading}
              onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}
              className="rounded-lg border border-line bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-surface-3 disabled:opacity-30"
            >
              Previous
            </button>
            <button
              disabled={offset + LIMIT >= total || loading}
              onClick={() => setOffset((o) => o + LIMIT)}
              className="rounded-lg border border-line bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-surface-3 disabled:opacity-30"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {/* Detail Pane / Drawer */}
      {selectedId && (
        <div className="w-full border-t border-line lg:w-96 lg:shrink-0 lg:border-t-0 lg:border-l bg-surface-2/30 flex flex-col h-full overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-3 bg-surface">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink">
              User Profile & Usage
            </h3>
            <button
              onClick={() => {
                setSelectedId(null)
                setDetail(null)
              }}
              className="rounded-md p-1 text-ink-2 hover:bg-surface-3 hover:text-ink"
            >
              <X size={15} />
            </button>
          </div>

          {!detail ? (
            <div className="flex flex-col items-center justify-center py-20 gap-2">
              <Loader2 size={22} className="animate-spin text-ink-2" />
              <p className="text-xs text-ink-2">Loading user breakdown…</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
              {/* Header card */}
              <div className="rounded-2xl border border-line bg-surface p-4 text-center">
                <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-base font-bold text-white shadow-sm">
                  {(detail.user.name ?? detail.user.email).charAt(0).toUpperCase()}
                </div>
                <h4 className="mt-2 font-semibold text-ink text-sm">
                  {detail.user.name ?? 'Anonymous User'}
                </h4>
                <p className="font-mono text-[11px] text-ink-2">{detail.user.email}</p>

                <div className="mt-3 flex items-center justify-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      detail.user.role === 'admin'
                        ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400'
                        : 'bg-surface-3 text-ink-2'
                    }`}
                  >
                    {detail.user.role}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      detail.user.status === 'suspended'
                        ? 'bg-red-500/10 text-red-500'
                        : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    }`}
                  >
                    {detail.user.status}
                  </span>
                </div>
              </div>

              {/* Account stats grid */}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl border border-line bg-surface p-2.5">
                  <span className="text-[10px] text-ink-2">Joined</span>
                  <p className="font-semibold text-ink mt-0.5">
                    {new Date(detail.user.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="rounded-xl border border-line bg-surface p-2.5">
                  <span className="text-[10px] text-ink-2">Total Logins</span>
                  <p className="font-semibold text-ink mt-0.5">{detail.user.loginCount}</p>
                </div>
                <div className="rounded-xl border border-line bg-surface p-2.5">
                  <span className="text-[10px] text-ink-2">Messages Today</span>
                  <p className="font-semibold text-ink mt-0.5">{detail.usage.messagesToday}</p>
                </div>
                <div className="rounded-xl border border-line bg-surface p-2.5">
                  <span className="text-[10px] text-ink-2">Storage Usage</span>
                  <p className="font-semibold text-ink mt-0.5">
                    {formatBytes(detail.usage.storageBytes)}
                  </p>
                </div>
              </div>

              {/* Recent Conversations */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h5 className="font-semibold text-ink text-xs flex items-center gap-1.5">
                    <MessageSquare size={13} className="text-accent" />
                    Recent Conversations ({detail.sessions.length})
                  </h5>
                </div>
                {detail.sessions.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-line p-3 text-center text-ink-2">
                    No conversations found.
                  </p>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {detail.sessions.slice(0, 10).map((s) => (
                      <button
                        key={s.id}
                        onClick={() => onOpenSession?.(s.id)}
                        disabled={!onOpenSession}
                        className="group flex w-full items-center justify-between rounded-xl border border-line bg-surface p-2 text-left transition-colors hover:border-accent hover:bg-surface-3"
                      >
                        <div className="min-w-0 flex-1 pr-2">
                          <p className="truncate text-xs font-medium text-ink group-hover:text-accent">
                            {s.title}
                          </p>
                          <span className="text-[10px] text-ink-2">
                            {new Date(s.updatedAt).toLocaleDateString()} · {s.messageCount} msgs
                          </span>
                        </div>
                        {s.deletedAt && (
                          <span className="rounded bg-red-500/10 px-1 py-0.5 text-[9px] text-red-500">
                            deleted
                          </span>
                        )}
                        <ChevronRight size={13} className="text-ink-2 group-hover:text-accent" />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Recent Activity Audit */}
              <div>
                <h5 className="font-semibold text-ink text-xs mb-2 flex items-center gap-1.5">
                  <Activity size={13} className="text-accent" />
                  Recent Activity Logs
                </h5>
                {detail.activity.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-line p-3 text-center text-ink-2">
                    No activity logs recorded.
                  </p>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {detail.activity.slice(0, 15).map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center justify-between rounded-lg border border-line/60 bg-surface px-2.5 py-1.5"
                      >
                        <span className="font-mono text-[10px] text-ink">{a.action}</span>
                        <span className="text-[10px] text-ink-2">
                          {new Date(a.timestamp).toLocaleDateString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

