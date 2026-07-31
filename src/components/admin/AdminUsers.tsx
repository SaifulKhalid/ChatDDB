import { useEffect, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
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

  // Debounce the search box only; the selects and pager apply immediately.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(t)
  }, [search])

  // One fetch path for mount, filters and paging — the previous version had a
  // mount effect and a `load()` helper that could disagree about the filters.
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
      .then((res) => { if (!cancelled) { setRows(res.users); setTotal(res.total) } })
      .catch((e) => { if (!cancelled) setError(errorText(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [debouncedSearch, statusFilter, roleFilter, offset])

  async function selectUser(id: string) {
    setSelectedId(id)
    setDetail(null)
    try {
      setDetail(await adminApi.user(id))
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function patchUser(id: string, body: { status?: 'active' | 'suspended'; role?: 'user' | 'admin' }) {
    const label =
      body.status === 'suspended' ? 'suspend'
        : body.status === 'active' ? 'reactivate'
          : body.role === 'admin' ? 'grant admin to'
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
    <div className="flex h-full flex-col md:flex-row">
      {/* Table pane */}
      <div className="flex min-w-0 flex-1 flex-col border-r border-line">
        {/* Filters */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <div className="flex flex-1 items-center gap-2 rounded-lg bg-surface-2 px-3 py-1.5 text-sm">
            <Search size={15} className="shrink-0 text-ink-2" />
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setOffset(0) }}
              placeholder="Search by name or email…"
              className="flex-1 bg-transparent text-ink outline-none placeholder:text-ink-2"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setOffset(0) }}
            aria-label="Filter by status"
            className="rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink outline-none"
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
          <select
            value={roleFilter}
            onChange={(e) => { setRoleFilter(e.target.value); setOffset(0) }}
            aria-label="Filter by role"
            className="rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink outline-none"
          >
            <option value="">All roles</option>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>

        {error && <p className="border-b border-line px-4 py-2 text-sm text-red-500">{error}</p>}

        {/* Table */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8"><Loader2 size={20} className="animate-spin text-ink-2" /></div>
          ) : rows.length === 0 ? (
            <p className="p-4 text-center text-sm text-ink-2">No users found.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="sticky top-0 bg-surface text-xs text-ink-2">
                  <th className="px-3 py-2 text-left font-medium">User</th>
                  <th className="px-3 py-2 text-left font-medium">Role</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Sessions</th>
                  <th className="px-3 py-2 text-right font-medium">Messages</th>
                  <th className="px-3 py-2 text-right font-medium">Files</th>
                  <th className="px-3 py-2 text-right font-medium">Last login</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => void selectUser(row.id)}
                    className={`cursor-pointer border-t border-line hover:bg-surface-2 ${
                      selectedId === row.id ? 'bg-surface-2' : ''
                    }`}
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-medium text-white">
                          {(row.name ?? row.email).charAt(0).toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium text-ink">{row.name ?? '—'}</p>
                          <p className="truncate text-xs text-ink-2">{row.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={`rounded-full px-2 py-0.5 font-medium ${
                        row.role === 'admin' ? 'bg-accent/10 text-accent' : 'text-ink-2'
                      }`}>
                        {row.role}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={`rounded-full px-2 py-0.5 ${
                        row.status === 'suspended' ? 'bg-red-500/10 text-red-500' : 'text-ink-2'
                      }`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-ink-2">{row.counts.sessions}</td>
                    <td className="px-3 py-2 text-right text-ink-2">{row.counts.messages}</td>
                    <td className="px-3 py-2 text-right text-ink-2">{row.counts.files}</td>
                    <td className="px-3 py-2 text-right text-xs text-ink-2">
                      {row.lastLogin ? new Date(row.lastLogin).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-3 py-2">
                      {/* No self-suspend, no self-demote: an admin locking themselves
                          out would need a manual D1 write to recover. */}
                      {row.id !== currentId && busyId !== row.id && (
                        <div className="flex gap-1">
                          {row.status === 'active' ? (
                            <button
                              onClick={(e) => { e.stopPropagation(); void patchUser(row.id, { status: 'suspended' }) }}
                              className="rounded px-2 py-1 text-xs text-ink-2 hover:bg-red-500/10 hover:text-red-500"
                              title="Suspend user"
                            >
                              Suspend
                            </button>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); void patchUser(row.id, { status: 'active' }) }}
                              className="rounded px-2 py-1 text-xs text-ink-2 hover:bg-accent/10 hover:text-accent"
                              title="Reactivate user"
                            >
                              Reactivate
                            </button>
                          )}
                          {row.role === 'user' ? (
                            <button
                              onClick={(e) => { e.stopPropagation(); void patchUser(row.id, { role: 'admin' }) }}
                              className="rounded px-2 py-1 text-xs text-ink-2 hover:bg-accent/10 hover:text-accent"
                              title="Make admin"
                            >
                              Make admin
                            </button>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); void patchUser(row.id, { role: 'user' }) }}
                              className="rounded px-2 py-1 text-xs text-ink-2 hover:bg-red-500/10 hover:text-red-500"
                              title="Remove admin"
                            >
                              Remove admin
                            </button>
                          )}
                        </div>
                      )}
                      {busyId === row.id && <Loader2 size={14} className="animate-spin text-ink-2" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-ink-2">
          <span>
            {total === 0 ? '0 total' : `${offset + 1}–${Math.min(offset + LIMIT, total)} of ${total}`}
          </span>
          <div className="flex gap-2">
            <button
              disabled={offset === 0 || loading}
              onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}
              className="rounded px-2 py-1 hover:bg-surface-3 disabled:opacity-30"
            >
              Previous
            </button>
            <button
              disabled={offset + LIMIT >= total || loading}
              onClick={() => setOffset((o) => o + LIMIT)}
              className="rounded px-2 py-1 hover:bg-surface-3 disabled:opacity-30"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {/* Detail pane */}
      {selectedId && (
        <div className="w-full border-t border-line md:w-80 md:shrink-0 md:border-t-0">
          {!detail ? (
            <div className="flex items-center justify-center py-8"><Loader2 size={18} className="animate-spin text-ink-2" /></div>
          ) : (
            <div className="max-h-full overflow-y-auto p-4 text-sm">
              <h3 className="mb-3 font-semibold text-ink">User detail</h3>
              <div className="space-y-2 text-xs">
                <p><span className="text-ink-2">Email:</span> {detail.user.email}</p>
                <p><span className="text-ink-2">Name:</span> {detail.user.name ?? '—'}</p>
                <p><span className="text-ink-2">Role:</span> {detail.user.role}</p>
                <p><span className="text-ink-2">Status:</span> {detail.user.status}</p>
                <p><span className="text-ink-2">Joined:</span> {new Date(detail.user.createdAt).toLocaleDateString()}</p>
                <p><span className="text-ink-2">Last login:</span> {detail.user.lastLogin ? new Date(detail.user.lastLogin).toLocaleString() : '—'}</p>
                <p><span className="text-ink-2">Login count:</span> {detail.user.loginCount}</p>
                <hr className="border-line" />
                <p><span className="text-ink-2">Sessions:</span> {detail.usage.sessions}</p>
                <p><span className="text-ink-2">Messages:</span> {detail.usage.messages}</p>
                <p><span className="text-ink-2">Messages today:</span> {detail.usage.messagesToday}</p>
                <p><span className="text-ink-2">Files:</span> {detail.usage.files}</p>
                <p><span className="text-ink-2">Storage:</span> {formatBytes(detail.usage.storageBytes)}</p>
              </div>

              {detail.sessions.length > 0 && (
                <>
                  <h4 className="mb-2 mt-4 text-xs font-semibold text-ink-2">Recent conversations</h4>
                  <div className="space-y-1">
                    {detail.sessions.slice(0, 10).map((s) => (
                      <button
                        key={s.id}
                        onClick={() => onOpenSession?.(s.id)}
                        disabled={!onOpenSession}
                        title={onOpenSession ? `Open transcript — ${s.title}` : s.title}
                        className="flex w-full items-center gap-2 rounded bg-surface-2 px-2 py-1 text-left text-xs text-ink-2 enabled:hover:bg-surface-3 enabled:hover:text-ink"
                      >
                        <span className="min-w-0 flex-1 truncate">{s.title}</span>
                        {s.deletedAt && <span className="shrink-0 text-[10px] text-red-500">deleted</span>}
                        <span className="shrink-0 text-[10px] tabular-nums">{s.messageCount}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {detail.activity.length > 0 && (
                <>
                  <h4 className="mb-2 mt-4 text-xs font-semibold text-ink-2">Recent activity</h4>
                  <div className="space-y-1">
                    {detail.activity.slice(0, 15).map((a) => (
                      <p key={a.id} className="flex items-baseline gap-2 text-xs text-ink-2">
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{a.action}</span>
                        <span className="shrink-0 text-[10px]">{new Date(a.timestamp).toLocaleDateString()}</span>
                      </p>
                    ))}
                  </div>
                </>
              )}
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
