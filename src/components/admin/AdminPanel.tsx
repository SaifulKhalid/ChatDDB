import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Database,
  FileText,
  HardDrive,
  ImageIcon,
  Loader2,
  MessageSquare,
  RefreshCw,
  Shield,
  Sparkles,
  TrendingUp,
  UserCheck,
  Users,
  UserX,
} from 'lucide-react'
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
  const [refreshing, setRefreshing] = useState(false)
  /** Set by the Users tab so a conversation there opens in the Inspect tab. */
  const [inspectSessionId, setInspectSessionId] = useState<string | null>(null)

  function loadStats() {
    setRefreshing(true)
    setStatsError(null)
    adminApi.stats()
      .then((s) => {
        setStats(s)
      })
      .catch((e) => {
        setStatsError(errorText(e))
      })
      .finally(() => {
        setRefreshing(false)
      })
  }

  useEffect(() => {
    loadStats()
  }, [])

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onExit}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <ArrowLeft size={14} />
            Back to chat
          </button>
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-lg bg-ink text-surface">
              <Shield size={16} />
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-none text-ink">ChatDDB Administration</h1>
              <p className="mt-0.5 text-[11px] text-ink-2">System metrics & management portal</p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {tab === 'overview' && (
            <button
              onClick={loadStats}
              disabled={refreshing}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-50"
              title="Refresh statistics"
            >
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
              <span>{refreshing ? 'Refreshing…' : 'Refresh'}</span>
            </button>
          )}

          <div className="flex rounded-lg border border-line bg-surface-2 p-0.5">
            {(
              [
                { id: 'overview', label: 'Overview', icon: <TrendingUp size={13} /> },
                { id: 'users', label: 'Users', icon: <Users size={13} /> },
                { id: 'inspect', label: 'Inspector', icon: <Activity size={13} /> },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  tab === t.id
                    ? 'bg-ink text-surface shadow-sm'
                    : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
                }`}
              >
                {t.icon}
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Error bar */}
      {statsError && (
        <div className="mx-4 mt-3 flex items-center justify-between rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
          <span>{statsError}</span>
          <button
            onClick={loadStats}
            className="rounded px-2 py-0.5 text-xs font-medium underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'overview' && <Overview stats={stats} failed={!!statsError} />}
        {tab === 'users' && (
          <AdminUsers
            onOpenSession={(id) => {
              setInspectSessionId(id)
              setTab('inspect')
            }}
          />
        )}
        {tab === 'inspect' && <AdminInspector initialSessionId={inspectSessionId} />}
      </div>
    </div>
  )
}

function Overview({ stats, failed }: { stats: AdminStats | null; failed: boolean }) {
  if (!stats) {
    if (failed) return null
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={28} className="animate-spin text-ink-2" />
      </div>
    )
  }

  const { platform, storage, actions } = stats
  const sortedActions = [...actions].sort((a, b) => b.n - a.n)
  const totalActionCounts = sortedActions.reduce((acc, a) => acc + a.n, 0)

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
      {/* Top Welcome / Health Banner */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-line bg-gradient-to-br from-surface-2 to-surface-3/60 p-4 lg:col-span-2">
          <div className="flex items-start justify-between">
            <div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 size={13} />
                All Systems Operational
              </span>
              <h2 className="mt-2 text-base font-semibold text-ink">
                Platform Statistics & Operational Health
              </h2>
              <p className="mt-1 text-xs text-ink-2">
                Uncensored real-time messaging, multi-key resilience, SVG engine and image generation
                are active.
              </p>
            </div>
            <span className="text-[11px] text-ink-2">
              Updated {new Date(stats.generatedAt).toLocaleTimeString()}
            </span>
          </div>

          {/* Quick inline metric strip */}
          <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line/60 pt-3">
            <div>
              <p className="text-[11px] text-ink-2">New Users Today</p>
              <p className="text-sm font-semibold text-ink">+{platform.newUsersToday}</p>
            </div>
            <div>
              <p className="text-[11px] text-ink-2">Messages Today</p>
              <p className="text-sm font-semibold text-ink">{platform.messagesToday}</p>
            </div>
            <div>
              <p className="text-[11px] text-ink-2">Active Ratio</p>
              <p className="text-sm font-semibold text-ink">
                {platform.totalUsers > 0
                  ? `${Math.round((platform.activeUsers / platform.totalUsers) * 100)}%`
                  : '0%'}
              </p>
            </div>
          </div>
        </div>

        {/* System Health Breakdown Card */}
        <div className="flex flex-col justify-between rounded-2xl border border-line bg-surface-2 p-4">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-2">
              Service Status
            </h3>
            <div className="mt-3 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-ink">
                  <Database size={13} className="text-emerald-500" />
                  Cloudflare D1 Database
                </span>
                <span className="text-emerald-600 dark:text-emerald-400 font-medium">Ready</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-ink">
                  <HardDrive size={13} className="text-emerald-500" />
                  R2 Object Storage
                </span>
                <span className="text-emerald-600 dark:text-emerald-400 font-medium">Ready</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-ink">
                  <Sparkles size={13} className="text-emerald-500" />
                  AI Image Generation
                </span>
                <span className="text-emerald-600 dark:text-emerald-400 font-medium">Active</span>
              </div>
            </div>
          </div>
          <div className="mt-3 border-t border-line pt-2 text-[11px] text-ink-2">
            Storage used: <span className="font-medium text-ink">{formatBytes(storage.totalBytes)}</span>
          </div>
        </div>
      </div>

      {/* Main KPI Stat Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={<Users size={16} className="text-blue-500" />}
          label="Total Users"
          value={String(platform.totalUsers)}
          subtitle={`${platform.activeUsers} active`}
        />
        <StatCard
          icon={<UserCheck size={16} className="text-emerald-500" />}
          label="Active Users"
          value={String(platform.activeUsers)}
          subtitle={`${platform.adminUsers} admin${platform.adminUsers !== 1 ? 's' : ''}`}
        />
        <StatCard
          icon={<UserX size={16} className="text-amber-500" />}
          label="Suspended"
          value={String(platform.suspendedUsers)}
          subtitle="Manual flags only"
        />
        <StatCard
          icon={<MessageSquare size={16} className="text-indigo-500" />}
          label="Total Chats"
          value={String(platform.totalSessions)}
          subtitle={`${platform.totalMessages} total msgs`}
        />
        <StatCard
          icon={<MessageSquare size={16} className="text-purple-500" />}
          label="Today's Messages"
          value={String(platform.messagesToday)}
          subtitle="Real-time count"
        />
        <StatCard
          icon={<FileText size={16} className="text-teal-500" />}
          label="Total Files"
          value={String(storage.totalFiles)}
          subtitle={`${storage.images} imgs · ${storage.pdfs} pdfs`}
        />
        <StatCard
          icon={<ImageIcon size={16} className="text-pink-500" />}
          label="Images Stored"
          value={String(storage.images)}
          subtitle="Uploaded & generated"
        />
        <StatCard
          icon={<HardDrive size={16} className="text-orange-500" />}
          label="R2 Storage"
          value={formatBytes(storage.totalBytes)}
          subtitle={`${storage.orphans} orphans`}
        />
      </div>

      {/* 14-day active users interactive chart */}
      <DauChart dau={platform.dau} />

      {/* Dual Column: Action Mix & Storage Distribution */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Actions mix */}
        <div className="rounded-2xl border border-line bg-surface-2 p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">Action Activity (Last 7 Days)</h2>
              <p className="text-[11px] text-ink-2">Total actions: {totalActionCounts}</p>
            </div>
            <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] font-medium text-ink-2">
              {sortedActions.length} types
            </span>
          </div>

          <div className="space-y-2.5">
            {sortedActions.map(({ action, n }) => {
              const pct = totalActionCounts > 0 ? Math.round((n / totalActionCounts) * 100) : 0
              return (
                <div key={action} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono text-ink text-[11px]">{action}</span>
                    <span className="text-ink-2 text-[11px]">
                      <strong className="text-ink">{n}</strong> ({pct}%)
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-surface-3 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-accent transition-all duration-300"
                      style={{ width: `${Math.max(4, pct)}%` }}
                    />
                  </div>
                </div>
              )
            })}
            {sortedActions.length === 0 && (
              <p className="py-6 text-center text-xs text-ink-2">No actions recorded in the past 7 days.</p>
            )}
          </div>
        </div>

        {/* Storage details & breakdown */}
        <div className="rounded-2xl border border-line bg-surface-2 p-4 flex flex-col justify-between">
          <div>
            <h2 className="text-sm font-semibold text-ink mb-1">Storage & Processing Status</h2>
            <p className="text-[11px] text-ink-2 mb-4">R2 bucket object distribution and pipeline health</p>

            <div className="grid grid-cols-2 gap-2.5 mb-4">
              <div className="rounded-xl border border-line bg-surface p-3">
                <p className="text-[11px] text-ink-2">Images Stored</p>
                <p className="text-base font-semibold text-ink mt-0.5">{storage.images}</p>
              </div>
              <div className="rounded-xl border border-line bg-surface p-3">
                <p className="text-[11px] text-ink-2">PDF Documents</p>
                <p className="text-base font-semibold text-ink mt-0.5">{storage.pdfs}</p>
              </div>
              <div className="rounded-xl border border-line bg-surface p-3">
                <p className="text-[11px] text-ink-2">Awaiting PDF Extraction</p>
                <p className="text-base font-semibold text-amber-500 mt-0.5">
                  {storage.pendingProcessing}
                </p>
              </div>
              <div className="rounded-xl border border-line bg-surface p-3">
                <p className="text-[11px] text-ink-2">Failed Extraction</p>
                <p className="text-base font-semibold text-red-500 mt-0.5">
                  {storage.failedProcessing}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-line/60 bg-surface/60 p-3 text-xs text-ink-2 space-y-1">
            {storage.orphans > 0 ? (
              <p className="text-amber-500/90 font-medium">
                ⚠️ {storage.orphans} orphaned file{storage.orphans !== 1 ? 's' : ''} older than 24h. Run{' '}
                <code className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[10px]">
                  npm run db:prune
                </code>{' '}
                to clean.
              </p>
            ) : (
              <p className="text-emerald-600 dark:text-emerald-400">
                ✓ No orphaned storage objects detected.
              </p>
            )}
            <p className="text-[11px]">
              Snapshot generated: {new Date(stats.generatedAt).toLocaleString()}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

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
    <div className="rounded-2xl border border-line bg-surface-2 p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Daily Active Users (14 Days)</h2>
          <p className="text-[11px] text-ink-2">Unique users sending messages per calendar day</p>
        </div>
        <span className="text-xs font-semibold text-accent">Peak: {peak} user{peak !== 1 ? 's' : ''}</span>
      </div>

      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="flex h-32 items-end gap-1 sm:gap-2">
          {days.map((d) => {
            const heightPct = Math.max(4, (d.users / peak) * 100)
            const dateStr = new Date(d.day).toLocaleDateString(undefined, {
              weekday: 'short',
              month: 'numeric',
              day: 'numeric',
            })
            const isToday = d.day === today
            return (
              <div
                key={d.day}
                className="group relative flex min-w-0 flex-1 flex-col items-center justify-end"
              >
                {/* Tooltip */}
                <div className="pointer-events-none absolute -top-8 z-10 hidden rounded bg-ink px-2 py-1 text-[10px] text-surface shadow group-hover:block whitespace-nowrap">
                  {dateStr}: <strong>{d.users} active</strong>
                </div>
                <span className="mb-1 text-[10px] font-medium text-ink-2 group-hover:text-ink">
                  {d.users > 0 ? d.users : ''}
                </span>
                <div
                  className={`w-full rounded-t transition-all ${
                    isToday ? 'bg-ink' : 'bg-accent/70 group-hover:bg-accent'
                  }`}
                  style={{ height: `${heightPct}%` }}
                />
              </div>
            )
          })}
        </div>
        <div className="mt-2 flex justify-between border-t border-line pt-1 text-[10px] text-ink-2">
          <span>{new Date(days[0].day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
          <span>Today ({new Date(today).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })})</span>
        </div>
      </div>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  subtitle,
}: {
  icon: ReactNode
  label: string
  value: string
  subtitle?: string
}) {
  return (
    <div className="flex flex-col justify-between rounded-2xl border border-line bg-surface-2 p-3.5 transition-shadow hover:shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink-2">{label}</span>
        <div className="flex size-7 items-center justify-center rounded-lg bg-surface-3">
          {icon}
        </div>
      </div>
      <div className="mt-2">
        <p className="text-xl font-bold text-ink">{value}</p>
        {subtitle && <p className="mt-0.5 text-[11px] text-ink-2">{subtitle}</p>}
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

