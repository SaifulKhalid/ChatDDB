import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeft, FileText, HardDrive, Loader2, MessageSquare, Users } from 'lucide-react'
import { adminApi } from '../../lib/adminApi'
import { errorText } from '../../lib/apiClient'
import type { AdminStats } from '../../lib/adminApi'
import { AdminUsers } from './AdminUsers'
import { AdminInspector } from './AdminInspector'

type Tab = 'overview' | 'users' | 'inspect'

export function AdminPanel({ onExit }: { onExit: () => void }) {
  const [tab, setTab] = useState<Tab>('overview')
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  /** Set by the Users tab so a conversation there opens in the Inspect tab. */
  const [inspectSessionId, setInspectSessionId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    adminApi.stats()
      .then((s) => { if (!cancelled) setStats(s) })
      .catch((e) => { if (!cancelled) setStatsError(errorText(e)) })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <button
          onClick={onExit}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-ink-2 hover:bg-surface-3 hover:text-ink"
        >
          <ArrowLeft size={16} />
          Back to chat
        </button>
        <h1 className="text-sm font-semibold">ChatDDB admin</h1>
        <div className="flex gap-1">
          {(['overview', 'users', 'inspect'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                tab === t ? 'bg-ink text-surface' : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
              }`}
            >
              {t === 'overview' ? 'Overview' : t === 'users' ? 'Users' : 'Inspect'}
            </button>
          ))}
        </div>
      </header>

      {/* Error bar */}
      {statsError && (
        <div className="mx-4 mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
          {statsError}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'overview' && <Overview stats={stats} failed={!!statsError} />}
        {tab === 'users' && (
          <AdminUsers
            onOpenSession={(id) => { setInspectSessionId(id); setTab('inspect') }}
          />
        )}
        {tab === 'inspect' && <AdminInspector initialSessionId={inspectSessionId} />}
      </div>
    </div>
  )
}

function Overview({ stats, failed }: { stats: AdminStats | null; failed: boolean }) {
  if (!stats) {
    // A failed request already shows the error bar above; a spinner that never
    // resolves would read as a hang.
    if (failed) return null
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={24} className="animate-spin text-ink-2" />
      </div>
    )
  }

  const { platform, storage, actions } = stats
  const sortedActions = [...actions].sort((a, b) => b.n - a.n)

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4">
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard icon={<Users size={16} />} label="Users" value={String(platform.totalUsers)} />
        <StatCard icon={<Users size={16} />} label="Active" value={String(platform.activeUsers)} />
        <StatCard icon={<Users size={16} />} label="Suspended" value={String(platform.suspendedUsers)} />
        <StatCard icon={<Users size={16} />} label="Admins" value={String(platform.adminUsers)} />
        <StatCard icon={<MessageSquare size={16} />} label="Conversations" value={String(platform.totalSessions)} />
        <StatCard icon={<MessageSquare size={16} />} label="Messages today" value={String(platform.messagesToday)} />
        <StatCard icon={<FileText size={16} />} label="Files" value={String(storage.totalFiles)} />
        <StatCard icon={<HardDrive size={16} />} label="Storage" value={formatBytes(storage.totalBytes)} />
      </div>

      {/* 14-day active users — a bare CSS bar chart, no chart library */}
      <DauChart dau={platform.dau} />

      {/* Actions table */}
      <div>
        <h2 className="mb-2 text-sm font-semibold text-ink">Actions (last 7 days)</h2>
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-2 text-xs text-ink-2">
                <th className="px-3 py-2 text-left font-medium">Action</th>
                <th className="px-3 py-2 text-right font-medium">Count</th>
              </tr>
            </thead>
            <tbody>
              {sortedActions.map(({ action, n }) => (
                <tr key={action} className="border-t border-line">
                  <td className="px-3 py-2 font-mono text-xs text-ink">{action}</td>
                  <td className="px-3 py-2 text-right text-ink-2">{n}</td>
                </tr>
              ))}
              {sortedActions.length === 0 && (
                <tr className="border-t border-line">
                  <td colSpan={2} className="px-3 py-4 text-center text-ink-2">No actions recorded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Storage detail */}
      <div className="space-y-1 text-xs text-ink-2">
        <p>
          {storage.images} image{storage.images !== 1 ? 's' : ''} · {storage.pdfs} PDF
          {storage.pdfs !== 1 ? 's' : ''} · {storage.pendingProcessing} awaiting extraction ·{' '}
          {storage.failedProcessing} failed
        </p>
        {storage.orphans > 0 && (
          <p>
            {storage.orphans} orphaned file{storage.orphans !== 1 ? 's' : ''} — uploaded but never attached
            to a message, older than 24h. <code>npm run db:prune</code> clears these.
          </p>
        )}
        <p>Generated at {new Date(stats.generatedAt).toLocaleString()}</p>
      </div>
    </div>
  )
}

/**
 * Daily active users over the window `platformStats` was asked for.
 *
 * The Worker only returns days that had at least one message, so the series is
 * filled forward from the oldest day present — otherwise a quiet day would close
 * the gap and shift every bar left.
 */
function DauChart({ dau }: { dau: { day: number; users: number }[] }) {
  if (dau.length === 0) return null

  const DAY = 86_400_000
  const today = Math.floor(Date.now() / DAY) * DAY
  const first = Math.min(dau[0].day, today - 13 * DAY)
  const byDay = new Map(dau.map((d) => [d.day, d.users]))
  const days: { day: number; users: number }[] = []
  for (let d = first; d <= today; d += DAY) days.push({ day: d, users: byDay.get(d) ?? 0 })

  const peak = Math.max(1, ...days.map((d) => d.users))

  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold text-ink">Active users per day</h2>
      <div className="rounded-xl border border-line bg-surface-2 p-4">
        <div className="flex h-28 items-end gap-1">
          {days.map((d) => (
            <div key={d.day} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
              <span className="text-[10px] text-ink-2">{d.users || ''}</span>
              <div
                className="w-full rounded-t bg-accent/70"
                style={{ height: `${Math.max(2, (d.users / peak) * 100)}%` }}
                title={`${new Date(d.day).toLocaleDateString()} — ${d.users} active`}
              />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-ink-2">
          <span>{new Date(days[0].day).toLocaleDateString()}</span>
          <span>{new Date(days[days.length - 1].day).toLocaleDateString()}</span>
        </div>
      </div>
    </div>
  )
}

function StatCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex items-center gap-2 text-ink-2">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="mt-1 text-lg font-semibold text-ink">{value}</p>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
