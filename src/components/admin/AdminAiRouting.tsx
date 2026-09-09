import { useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Cpu,
  Edit2,
  Layers,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  X,
  XCircle,
  Zap,
} from 'lucide-react'
import { adminApi } from '../../lib/adminApi'
import { errorText } from '../../lib/apiClient'
import type {
  AdminAiHealthResponse,
  AdminAiService,
  AdminProvider,
  AdminRoute,
  VerifyAllReport,
} from '../../lib/apiTypes'

type SubView = 'health' | 'services' | 'routes' | 'providers'

export function AdminAiRouting() {
  const [subView, setSubView] = useState<SubView>('health')
  const [healthData, setHealthData] = useState<AdminAiHealthResponse | null>(null)
  const [services, setServices] = useState<AdminAiService[]>([])
  const [providers, setProviders] = useState<AdminProvider[]>([])
  const [routes, setRoutes] = useState<AdminRoute[]>([])

  const [loading, setLoading] = useState(true)
  const [verifying, setVerifying] = useState(false)
  const [lastVerifyReport, setLastVerifyReport] = useState<VerifyAllReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)

  // Testing states
  const [testingRouteId, setTestingRouteId] = useState<string | null>(null)
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; latencyMs: number; error?: string } | null>(null)

  // Modals / forms
  const [editService, setEditService] = useState<AdminAiService | null>(null)
  const [editProvider, setEditProvider] = useState<AdminProvider | null>(null)
  const [isNewProvider, setIsNewProvider] = useState(false)
  const [editRoute, setEditRoute] = useState<AdminRoute | null>(null)
  const [isNewRoute, setIsNewRoute] = useState(false)
  const [newRouteServiceId, setNewRouteServiceId] = useState<string>('')

  // Load all data
  async function loadAll(silent = false) {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [h, s, p, r] = await Promise.all([
        adminApi.aiHealth(),
        adminApi.aiServices.list(),
        adminApi.aiProviders.list(),
        adminApi.aiRoutes.list(),
      ])
      setHealthData(h)
      setServices(s.services)
      setProviders(p.providers)
      setRoutes(r.routes)
    } catch (e) {
      setError(errorText(e))
    } finally {
      if (!silent) setLoading(false)
    }
  }

  // 7.2 Auto-Verification on Open
  useEffect(() => {
    let mounted = true
    async function init() {
      await loadAll(false)
      if (mounted) {
        runVerifyAll()
      }
    }
    void init()
    return () => {
      mounted = false
    }
  }, [])

  async function runVerifyAll() {
    setVerifying(true)
    try {
      const report = await adminApi.verifyAll()
      setLastVerifyReport(report)
      // Refresh health view immediately
      const h = await adminApi.aiHealth()
      setHealthData(h)
      setActionSuccess(`Verified ${report.totalChecked} routes: ${report.healthyCount} healthy, ${report.failedCount} failed.`)
    } catch (e) {
      setError(`Verification probe failed: ${errorText(e)}`)
    } finally {
      setVerifying(false)
    }
  }

  async function testRoute(routeId: string) {
    setTestingRouteId(routeId)
    setTestResult(null)
    try {
      const res = await adminApi.aiRoutes.test(routeId)
      setTestResult({ id: routeId, ...res.result })
      // Refresh health in background
      void adminApi.aiHealth().then(setHealthData).catch(() => {})
    } catch (e) {
      setTestResult({ id: routeId, ok: false, latencyMs: 0, error: errorText(e) })
    } finally {
      setTestingRouteId(null)
    }
  }

  async function testProvider(providerId: string) {
    setTestingProviderId(providerId)
    setTestResult(null)
    try {
      const res = await adminApi.aiProviders.test(providerId)
      setTestResult({ id: providerId, ...res.result })
    } catch (e) {
      setTestResult({ id: providerId, ok: false, latencyMs: 0, error: errorText(e) })
    } finally {
      setTestingProviderId(null)
    }
  }

  async function toggleRoute(route: AdminRoute) {
    try {
      await adminApi.aiRoutes.patch(route.id, { enabled: route.enabled ? 0 : 1 })
      await loadAll(true)
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function toggleService(service: AdminAiService) {
    try {
      await adminApi.aiServices.patch(service.id, { enabled: service.enabled ? 0 : 1 })
      await loadAll(true)
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function toggleProvider(provider: AdminProvider) {
    try {
      await adminApi.aiProviders.patch(provider.id, { enabled: !provider.enabled })
      await loadAll(true)
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function adjustRoutePriority(route: AdminRoute, delta: number) {
    const newPriority = Math.max(1, route.priority + delta)
    try {
      await adminApi.aiRoutes.patch(route.id, { priority: newPriority })
      await loadAll(true)
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function deleteRoute(routeId: string) {
    if (!confirm('Are you sure you want to delete this route?')) return
    try {
      await adminApi.aiRoutes.delete(routeId)
      await loadAll(true)
      setActionSuccess('Route deleted.')
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function deleteProvider(providerId: string) {
    if (!confirm('Delete this provider? Routes using it must be removed first.')) return
    try {
      await adminApi.aiProviders.delete(providerId)
      await loadAll(true)
      setActionSuccess('Provider deleted.')
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      {/* Top Banner & Action Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-ink flex items-center gap-2">
            <Cpu className="text-accent" size={20} />
            AI Services & Multi-AI Routing
          </h2>
          <p className="text-xs text-ink-2">
            Private upstream routing, provider failover, circuit breakers & capabilities.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => loadAll(false)}
            disabled={loading || verifying}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-50"
            title="Refresh AI routing data"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            <span>Reload</span>
          </button>

          {/* 7.2 Prominent [VERIFY ALL] Button */}
          <button
            onClick={runVerifyAll}
            disabled={verifying}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white shadow-sm transition-all hover:bg-accent/90 disabled:opacity-50 active:scale-95"
            title="Run health probes across all enabled AI routes"
          >
            {verifying ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Play size={14} className="fill-current" />
            )}
            <span>{verifying ? 'Verifying All…' : 'VERIFY ALL'}</span>
          </button>
        </div>
      </div>

      {/* Global Status Banner */}
      {healthData && (
        <div
          className={`flex items-center justify-between rounded-xl border p-3.5 transition-all ${
            healthData.overallStatus === 'operational'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : healthData.overallStatus === 'degraded'
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400'
          }`}
        >
          <div className="flex items-center gap-2.5">
            {healthData.overallStatus === 'operational' && <CheckCircle2 size={18} className="shrink-0" />}
            {healthData.overallStatus === 'degraded' && <AlertTriangle size={18} className="shrink-0" />}
            {healthData.overallStatus === 'down' && <XCircle size={18} className="shrink-0" />}
            <div>
              <span className="text-xs font-semibold uppercase tracking-wider">System Status:</span>{' '}
              <span className="text-sm font-bold capitalize">{healthData.overallStatus}</span>
              <p className="text-[11px] opacity-85">
                {healthData.overallStatus === 'operational'
                  ? 'All primary AI routes are active and responding normally.'
                  : healthData.overallStatus === 'degraded'
                    ? 'Failover active: one or more primary routes degraded; backup routes serving.'
                    : 'Critical: All routes for one or more AI services are down.'}
              </p>
            </div>
          </div>
          {lastVerifyReport && (
            <div className="hidden text-right text-xs opacity-80 sm:block">
              Checked {lastVerifyReport.totalChecked} routes
              <br />
              {new Date(lastVerifyReport.timestamp).toLocaleTimeString()}
            </div>
          )}
        </div>
      )}

      {/* Messages */}
      {error && (
        <div className="flex items-center justify-between rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-500">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="hover:opacity-75">
            <X size={14} />
          </button>
        </div>
      )}
      {actionSuccess && (
        <div className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-600 dark:text-emerald-400">
          <span>{actionSuccess}</span>
          <button onClick={() => setActionSuccess(null)} className="hover:opacity-75">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Sub-Navigation Tabs */}
      <div className="flex rounded-lg border border-line bg-surface-2 p-1 text-xs">
        {[
          { id: 'health', label: 'Status & Probes', icon: <Activity size={14} /> },
          { id: 'routes', label: 'Routes & Failover', icon: <Layers size={14} /> },
          { id: 'providers', label: 'API Providers', icon: <Server size={14} /> },
          { id: 'services', label: 'AI Services', icon: <Cpu size={14} /> },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setSubView(t.id as SubView)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-2 font-medium transition-all ${
              subView === t.id
                ? 'bg-ink text-surface shadow-sm'
                : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
            }`}
          >
            {t.icon}
            <span className="hidden xs:inline sm:inline">{t.label}</span>
          </button>
        ))}
      </div>

      {/* ------------------------------------------------------------------- */}
      {/* 7.1 Status & Health Cards View */}
      {/* ------------------------------------------------------------------- */}
      {subView === 'health' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {healthData?.services.map((srvHealth) => {
              const { service, status, routes } = srvHealth
              const primaryRoute = routes.find((r) => r.route.priority === 1)
              const backupRoutes = routes.filter((r) => r.route.priority > 1)

              return (
                <div
                  key={service.id}
                  className="flex flex-col justify-between rounded-xl border border-line bg-surface p-4 shadow-sm transition-all hover:border-line/80"
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold text-ink">{service.public_name}</h3>
                          {service.default_service === 1 && (
                            <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                              Default
                            </span>
                          )}
                          {service.enabled === 0 && (
                            <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] font-medium text-ink-2">
                              Disabled
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-ink-2 mt-0.5">{service.description || 'Public AI Service'}</p>
                      </div>

                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider ${
                          status === 'operational'
                            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                            : status === 'degraded'
                              ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                              : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        <span className={`size-1.5 rounded-full ${
                          status === 'operational' ? 'bg-emerald-500' : status === 'degraded' ? 'bg-amber-500' : 'bg-rose-500'
                        }`} />
                        {status}
                      </span>
                    </div>

                    {/* Primary Route */}
                    <div className="rounded-lg bg-surface-2 p-2.5 text-xs">
                      <div className="flex items-center justify-between font-medium text-ink">
                        <span className="flex items-center gap-1 text-ink-2">
                          <Zap size={12} className="text-amber-500" />
                          Primary Route:
                        </span>
                        <span>{primaryRoute ? primaryRoute.provider.label : 'None configured'}</span>
                      </div>
                      {primaryRoute && (
                        <div className="mt-1 flex items-center justify-between text-[11px] text-ink-2">
                          <span>Model: {primaryRoute.route.upstream_model_id}</span>
                          <span className="font-mono">
                            {primaryRoute.health?.last_latency_ms != null
                              ? `${primaryRoute.health.last_latency_ms}ms`
                              : 'No probe'}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Fallbacks */}
                    {backupRoutes.length > 0 && (
                      <div className="space-y-1 text-xs">
                        <span className="text-[11px] font-medium text-ink-2">
                          Failover Route{backupRoutes.length > 1 ? 's' : ''} ({backupRoutes.length}):
                        </span>
                        <div className="space-y-1">
                          {backupRoutes.map((br) => (
                            <div
                              key={br.route.id}
                              className="flex items-center justify-between rounded border border-line/60 bg-surface-2/60 px-2 py-1 text-[11px]"
                            >
                              <div className="flex items-center gap-1.5">
                                <span className="font-bold text-accent">P{br.route.priority}</span>
                                <span>{br.provider.label}</span>
                                <span className="text-ink-2 font-mono">({br.route.upstream_model_id})</span>
                              </div>
                              <span
                                className={`text-[10px] font-medium ${
                                  br.status === 'healthy'
                                    ? 'text-emerald-500'
                                    : br.status === 'circuit_broken'
                                      ? 'text-rose-500'
                                      : 'text-amber-500'
                                }`}
                              >
                                {br.status}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Actions & Quick Probes */}
                  <div className="mt-3 flex items-center justify-between border-t border-line pt-2 text-xs">
                    <span className="text-[11px] text-ink-2">
                      {routes.length} route{routes.length !== 1 ? 's' : ''} configured
                    </span>
                    {primaryRoute && (
                      <button
                        onClick={() => testRoute(primaryRoute.route.id)}
                        disabled={testingRouteId === primaryRoute.route.id}
                        className="flex items-center gap-1 rounded bg-surface-2 px-2 py-1 text-ink transition-colors hover:bg-surface-3 active:scale-95"
                      >
                        {testingRouteId === primaryRoute.route.id ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Play size={10} className="fill-current" />
                        )}
                        <span>Probe Primary</span>
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Test Probe Result Card */}
          {testResult && (
            <div
              className={`rounded-xl border p-4 text-xs ${
                testResult.ok
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400'
              }`}
            >
              <div className="flex items-center justify-between font-semibold">
                <span className="flex items-center gap-1.5">
                  {testResult.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                  Probe {testResult.ok ? 'Successful' : 'Failed'}
                </span>
                <span className="font-mono">{testResult.latencyMs}ms</span>
              </div>
              {testResult.error && (
                <p className="mt-1 text-[11px] opacity-90">{testResult.error}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------------- */}
      {/* 7.4 Route Management View */}
      {/* ------------------------------------------------------------------- */}
      {subView === 'routes' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">Configured Routes by Service</h3>
            <button
              onClick={() => {
                setEditRoute(null)
                setIsNewRoute(true)
                setNewRouteServiceId(services[0]?.id || '')
              }}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90"
            >
              <Plus size={13} />
              <span>Add Route</span>
            </button>
          </div>

          {services.map((srv) => {
            const srvRoutes = routes
              .filter((r) => r.service_id === srv.id)
              .sort((a, b) => a.priority - b.priority)

            return (
              <div key={srv.id} className="rounded-xl border border-line bg-surface p-4 space-y-3">
                <div className="flex items-center justify-between border-b border-line pb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-ink">{srv.public_name}</span>
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-ink-2 font-mono">
                      {srv.key}
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      setEditRoute(null)
                      setIsNewRoute(true)
                      setNewRouteServiceId(srv.id)
                    }}
                    className="flex items-center gap-1 text-xs text-accent hover:underline"
                  >
                    <Plus size={12} />
                    <span>Add to {srv.public_name}</span>
                  </button>
                </div>

                {srvRoutes.length === 0 ? (
                  <p className="py-2 text-xs italic text-ink-2">No routes assigned to this service yet.</p>
                ) : (
                  <div className="space-y-2">
                    {srvRoutes.map((r) => {
                      const prov = providers.find((p) => p.id === r.provider_id)
                      const isTesting = testingRouteId === r.id

                      return (
                        <div
                          key={r.id}
                          className={`flex flex-col gap-2 rounded-lg border p-3 transition-colors sm:flex-row sm:items-center sm:justify-between ${
                            r.enabled === 0
                              ? 'border-line/40 bg-surface-2/40 opacity-60'
                              : 'border-line bg-surface-2'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            {/* Priority badge with touch reorder arrows */}
                            <div className="flex items-center gap-1">
                              <span className="flex size-6 items-center justify-center rounded bg-ink text-surface text-xs font-bold">
                                {r.priority}
                              </span>
                              <div className="flex flex-col">
                                <button
                                  type="button"
                                  disabled={r.priority <= 1}
                                  onClick={() => adjustRoutePriority(r, -1)}
                                  className="p-0.5 text-ink-2 hover:text-ink disabled:opacity-25"
                                  title="Increase priority (lower number)"
                                >
                                  <ArrowUp size={11} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => adjustRoutePriority(r, 1)}
                                  className="p-0.5 text-ink-2 hover:text-ink"
                                  title="Decrease priority (higher number)"
                                >
                                  <ArrowDown size={11} />
                                </button>
                              </div>
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-semibold text-xs text-ink">
                                  {prov ? prov.label : 'Unknown Provider'}
                                </span>
                                <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-mono text-ink-2">
                                  {r.upstream_model_id}
                                </span>
                                {r.weight > 1 && (
                                  <span className="text-[10px] text-ink-2">Weight: {r.weight}</span>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Mobile-friendly action row */}
                          <div className="flex items-center justify-end gap-2 border-t border-line/40 pt-2 sm:border-0 sm:pt-0">
                            <button
                              type="button"
                              onClick={() => testRoute(r.id)}
                              disabled={isTesting}
                              className="flex items-center gap-1 rounded bg-surface-3 px-2.5 py-1 text-xs text-ink hover:bg-surface-3/80 disabled:opacity-50"
                              title="Test this route immediately"
                            >
                              {isTesting ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                              <span>Test</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => toggleRoute(r)}
                              className={`rounded px-2.5 py-1 text-xs font-medium ${
                                r.enabled === 1
                                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                  : 'bg-surface-3 text-ink-2'
                              }`}
                            >
                              {r.enabled === 1 ? 'Enabled' : 'Disabled'}
                            </button>

                            <button
                              type="button"
                              onClick={() => {
                                setEditRoute(r)
                                setIsNewRoute(false)
                              }}
                              className="p-1.5 text-ink-2 hover:text-ink"
                              title="Edit route"
                            >
                              <Edit2 size={13} />
                            </button>

                            <button
                              type="button"
                              onClick={() => deleteRoute(r.id)}
                              className="p-1.5 text-rose-500 hover:text-rose-600"
                              title="Delete route"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ------------------------------------------------------------------- */}
      {/* 7.5 Provider Management View */}
      {/* ------------------------------------------------------------------- */}
      {subView === 'providers' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">Configured API Providers</h3>
            <button
              onClick={() => {
                setEditProvider(null)
                setIsNewProvider(true)
              }}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90"
            >
              <Plus size={13} />
              <span>Add Provider</span>
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {providers.map((prov) => {
              const isTesting = testingProviderId === prov.id
              const associatedRoutes = routes.filter((r) => r.provider_id === prov.id)

              return (
                <div
                  key={prov.id}
                  className={`flex flex-col justify-between rounded-xl border p-4 shadow-sm transition-all ${
                    prov.enabled
                      ? 'border-line bg-surface'
                      : 'border-line/50 bg-surface-2/40 opacity-75'
                  }`}
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-semibold text-ink">{prov.label}</h4>
                          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-mono text-ink-2">
                            {prov.adapter}
                          </span>
                        </div>
                        <p className="text-xs text-ink-2 font-mono truncate max-w-[260px]">{prov.baseUrl}</p>
                      </div>

                      <button
                        onClick={() => toggleProvider(prov)}
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          prov.enabled
                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : 'bg-surface-3 text-ink-2'
                        }`}
                      >
                        {prov.enabled ? 'Active' : 'Disabled'}
                      </button>
                    </div>

                    <div className="rounded-lg bg-surface-2 p-2 text-xs space-y-1">
                      <div className="flex items-center justify-between text-ink-2">
                        <span>API Key:</span>
                        <span className="font-mono text-ink font-semibold">
                          {prov.hasKey ? prov.maskedKey : <span className="text-amber-500">Env fallback</span>}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-ink-2">
                        <span>Timeout:</span>
                        <span className="font-mono">{prov.timeoutMs}ms</span>
                      </div>
                      <div className="flex items-center justify-between text-ink-2">
                        <span>Routes connected:</span>
                        <span className="font-semibold text-ink">{associatedRoutes.length}</span>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="mt-3 flex items-center justify-between border-t border-line pt-2 text-xs">
                    <button
                      type="button"
                      onClick={() => testProvider(prov.id)}
                      disabled={isTesting}
                      className="flex items-center gap-1 rounded bg-surface-2 px-2.5 py-1 text-ink hover:bg-surface-3 active:scale-95"
                    >
                      {isTesting ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                      <span>Test Connection</span>
                    </button>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setEditProvider(prov)
                          setIsNewProvider(false)
                        }}
                        className="rounded p-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink"
                        title="Edit provider"
                      >
                        <Edit2 size={13} />
                      </button>

                      <button
                        type="button"
                        onClick={() => deleteProvider(prov.id)}
                        className="rounded p-1.5 text-rose-500 hover:bg-rose-500/10"
                        title="Delete provider"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------- */}
      {/* 7.3 Service Management View */}
      {/* ------------------------------------------------------------------- */}
      {subView === 'services' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">Public AI Services</h3>
            <p className="text-xs text-ink-2">These are the services visible to end users.</p>
          </div>

          <div className="space-y-2">
            {services.map((srv) => {
              let caps: { vision?: boolean; documents?: boolean; reasoning?: boolean; tools?: boolean } = {}
              try {
                caps = JSON.parse(srv.capabilities)
              } catch {
                caps = {}
              }

              return (
                <div
                  key={srv.id}
                  className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <h4 className="font-bold text-ink">{srv.public_name}</h4>
                      <span className="font-mono text-xs text-ink-2">({srv.key})</span>
                      {srv.default_service === 1 && (
                        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                          Default
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-2">{srv.description || 'No description provided'}</p>

                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {caps.vision && (
                        <span className="rounded bg-surface-2 px-2 py-0.5 text-[10px] text-ink">Vision</span>
                      )}
                      {caps.documents && (
                        <span className="rounded bg-surface-2 px-2 py-0.5 text-[10px] text-ink">PDFs / Docs</span>
                      )}
                      {caps.reasoning && (
                        <span className="rounded bg-surface-2 px-2 py-0.5 text-[10px] text-ink">Reasoning</span>
                      )}
                      {caps.tools !== false && (
                        <span className="rounded bg-surface-2 px-2 py-0.5 text-[10px] text-ink">Tools / Images</span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 border-t border-line/50 pt-2 sm:border-0 sm:pt-0">
                    <button
                      type="button"
                      onClick={() => toggleService(srv)}
                      className={`rounded px-2.5 py-1 text-xs font-medium ${
                        srv.enabled === 1
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : 'bg-surface-3 text-ink-2'
                      }`}
                    >
                      {srv.enabled === 1 ? 'Enabled' : 'Disabled'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setEditService(srv)}
                      className="rounded bg-surface-2 p-1.5 text-ink hover:bg-surface-3"
                      title="Edit Service"
                    >
                      <Edit2 size={13} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------- */}
      {/* Modal: Edit AI Service */}
      {/* ------------------------------------------------------------------- */}
      {editService && (
        <ServiceModal
          service={editService}
          onClose={() => setEditService(null)}
          onSaved={() => {
            setEditService(null)
            loadAll(true)
            setActionSuccess('Service updated.')
          }}
        />
      )}

      {/* ------------------------------------------------------------------- */}
      {/* Modal: Add/Edit Provider */}
      {/* ------------------------------------------------------------------- */}
      {(editProvider || isNewProvider) && (
        <ProviderModal
          provider={editProvider}
          isNew={isNewProvider}
          onClose={() => {
            setEditProvider(null)
            setIsNewProvider(false)
          }}
          onSaved={() => {
            setEditProvider(null)
            setIsNewProvider(false)
            loadAll(true)
            setActionSuccess(isNewProvider ? 'Provider created.' : 'Provider updated.')
          }}
        />
      )}

      {/* ------------------------------------------------------------------- */}
      {/* Modal: Add/Edit Route */}
      {/* ------------------------------------------------------------------- */}
      {(editRoute || isNewRoute) && (
        <RouteModal
          route={editRoute}
          isNew={isNewRoute}
          defaultServiceId={newRouteServiceId}
          services={services}
          providers={providers}
          onClose={() => {
            setEditRoute(null)
            setIsNewRoute(false)
          }}
          onSaved={() => {
            setEditRoute(null)
            setIsNewRoute(false)
            loadAll(true)
            setActionSuccess(isNewRoute ? 'Route created.' : 'Route updated.')
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Service Modal
// ---------------------------------------------------------------------------

function ServiceModal({
  service,
  onClose,
  onSaved,
}: {
  service: AdminAiService
  onClose: () => void
  onSaved: () => void
}) {
  const [publicName, setPublicName] = useState(service.public_name)
  const [description, setDescription] = useState(service.description || '')
  const [defaultService, setDefaultService] = useState(service.default_service === 1)

  let initCaps = { vision: false, documents: true, reasoning: false, tools: true }
  try {
    initCaps = { ...initCaps, ...JSON.parse(service.capabilities) }
  } catch {}
  const [caps, setCaps] = useState(initCaps)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setErr(null)
    try {
      await adminApi.aiServices.patch(service.id, {
        publicName,
        description,
        defaultService,
        capabilities: caps,
      })
      onSaved()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-xl space-y-4">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <h3 className="font-bold text-ink">Edit AI Service: {service.public_name}</h3>
          <button onClick={onClose} className="text-ink-2 hover:text-ink">
            <X size={16} />
          </button>
        </div>

        {err && <p className="text-xs text-rose-500">{err}</p>}

        <form onSubmit={handleSave} className="space-y-3 text-xs">
          <div>
            <label className="block font-medium text-ink-2 mb-1">Public Display Name</label>
            <input
              type="text"
              required
              value={publicName}
              onChange={(e) => setPublicName(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-ink outline-none focus:border-accent"
            />
          </div>

          <div>
            <label className="block font-medium text-ink-2 mb-1">Description</label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-ink outline-none focus:border-accent"
            />
          </div>

          <div className="space-y-2 pt-1">
            <label className="block font-medium text-ink-2">Capabilities</label>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex items-center gap-2 text-ink">
                <input
                  type="checkbox"
                  checked={caps.vision}
                  onChange={(e) => setCaps({ ...caps, vision: e.target.checked })}
                />
                <span>Vision (images)</span>
              </label>
              <label className="flex items-center gap-2 text-ink">
                <input
                  type="checkbox"
                  checked={caps.documents}
                  onChange={(e) => setCaps({ ...caps, documents: e.target.checked })}
                />
                <span>Documents (PDF)</span>
              </label>
              <label className="flex items-center gap-2 text-ink">
                <input
                  type="checkbox"
                  checked={caps.reasoning}
                  onChange={(e) => setCaps({ ...caps, reasoning: e.target.checked })}
                />
                <span>Deep Reasoning</span>
              </label>
              <label className="flex items-center gap-2 text-ink">
                <input
                  type="checkbox"
                  checked={caps.tools}
                  onChange={(e) => setCaps({ ...caps, tools: e.target.checked })}
                />
                <span>Image Gen Tools</span>
              </label>
            </div>
          </div>

          <div className="pt-1">
            <label className="flex items-center gap-2 text-ink font-medium">
              <input
                type="checkbox"
                checked={defaultService}
                onChange={(e) => setDefaultService(e.target.checked)}
              />
              <span>Set as default platform AI Service</span>
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-line">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-line px-3 py-1.5 text-ink-2 hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-accent px-4 py-1.5 font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Provider Modal
// ---------------------------------------------------------------------------

function ProviderModal({
  provider,
  isNew,
  onClose,
  onSaved,
}: {
  provider: AdminProvider | null
  isNew: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [key, setKey] = useState(provider?.key || '')
  const [label, setLabel] = useState(provider?.label || '')
  const [adapter, setAdapter] = useState(provider?.adapter || 'openai')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl || 'https://api.openai.com/v1')
  const [apiKey, setApiKey] = useState('')
  const [timeoutMs, setTimeoutMs] = useState(provider?.timeoutMs || 45000)
  const [enabled, setEnabled] = useState(provider ? provider.enabled : true)

  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setErr(null)
    try {
      if (isNew) {
        await adminApi.aiProviders.create({
          key,
          label,
          adapter,
          baseUrl,
          apiKey: apiKey || undefined,
          timeoutMs,
          enabled,
        })
      } else if (provider) {
        await adminApi.aiProviders.patch(provider.id, {
          label,
          adapter,
          baseUrl,
          ...(apiKey ? { apiKey } : {}),
          timeoutMs,
          enabled,
        })
      }
      onSaved()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-xl space-y-4">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <h3 className="font-bold text-ink">
            {isNew ? 'Add API Provider' : `Edit Provider: ${provider?.label}`}
          </h3>
          <button onClick={onClose} className="text-ink-2 hover:text-ink">
            <X size={16} />
          </button>
        </div>

        {err && <p className="text-xs text-rose-500">{err}</p>}

        <form onSubmit={handleSave} className="space-y-3 text-xs">
          {isNew && (
            <div>
              <label className="block font-medium text-ink-2 mb-1">Unique Key (e.g. `openai-direct`)</label>
              <input
                type="text"
                required
                value={key}
                onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
                className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-ink outline-none focus:border-accent font-mono"
              />
            </div>
          )}

          <div>
            <label className="block font-medium text-ink-2 mb-1">Display Label</label>
            <input
              type="text"
              required
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-ink outline-none focus:border-accent"
            />
          </div>

          <div>
            <label className="block font-medium text-ink-2 mb-1">Adapter Protocol</label>
            <select
              value={adapter}
              onChange={(e) => setAdapter(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-ink outline-none focus:border-accent"
            >
              <option value="openai">OpenAI Compatible (ChatGPT, DeepSeek, GLM, Grok)</option>
              <option value="anthropic">Anthropic Messages (Claude)</option>
              <option value="gemini">Google Gemini AI Studio</option>
            </select>
          </div>

          <div>
            <label className="block font-medium text-ink-2 mb-1">Base URL</label>
            <input
              type="url"
              required
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-ink outline-none focus:border-accent font-mono"
            />
          </div>

          <div>
            <label className="block font-medium text-ink-2 mb-1">
              API Key {!isNew && provider?.hasKey && `(Current: ${provider.maskedKey})`}
            </label>
            <input
              type="password"
              value={apiKey}
              placeholder={!isNew ? 'Leave blank to keep existing key' : 'Enter API key'}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-ink outline-none focus:border-accent font-mono"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block font-medium text-ink-2 mb-1">Timeout (ms)</label>
              <input
                type="number"
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(Number(e.target.value))}
                className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-ink outline-none focus:border-accent"
              />
            </div>
            <div className="flex items-center pt-5">
              <label className="flex items-center gap-2 text-ink">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span>Enabled</span>
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-line">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-line px-3 py-1.5 text-ink-2 hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-accent px-4 py-1.5 font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : isNew ? 'Create Provider' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Route Modal
// ---------------------------------------------------------------------------

function RouteModal({
  route,
  isNew,
  defaultServiceId,
  services,
  providers,
  onClose,
  onSaved,
}: {
  route: AdminRoute | null
  isNew: boolean
  defaultServiceId: string
  services: AdminAiService[]
  providers: AdminProvider[]
  onClose: () => void
  onSaved: () => void
}) {
  const [serviceId, setServiceId] = useState(route?.service_id || defaultServiceId || services[0]?.id || '')
  const [providerId, setProviderId] = useState(route?.provider_id || providers[0]?.id || '')
  const [upstreamModelId, setUpstreamModelId] = useState(route?.upstream_model_id || '')
  const [priority, setPriority] = useState(route?.priority ?? 1)
  const [weight, setWeight] = useState(route?.weight ?? 1)
  const [enabled, setEnabled] = useState(route ? route.enabled === 1 : true)

  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setErr(null)
    try {
      if (isNew) {
        await adminApi.aiRoutes.create({
          serviceId,
          providerId,
          upstreamModelId,
          priority,
          weight,
          enabled,
        })
      } else if (route) {
        await adminApi.aiRoutes.patch(route.id, {
          providerId,
          upstreamModelId,
          priority,
          weight,
          enabled: enabled ? 1 : 0,
        })
      }
      onSaved()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-xl space-y-4">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <h3 className="font-bold text-ink">{isNew ? 'Add AI Route' : 'Edit AI Route'}</h3>
          <button onClick={onClose} className="text-ink-2 hover:text-ink">
            <X size={16} />
          </button>
        </div>

        {err && <p className="text-xs text-rose-500">{err}</p>}

        <form onSubmit={handleSave} className="space-y-3 text-xs">
          <div>
            <label className="block font-medium text-ink-2 mb-1">AI Service</label>
            <select
              disabled={!isNew}
              value={serviceId}
              onChange={(e) => setServiceId(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-ink outline-none focus:border-accent disabled:opacity-60"
            >
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.public_name} ({s.key})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block font-medium text-ink-2 mb-1">API Provider</label>
            <select
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-ink outline-none focus:border-accent"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.baseUrl})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block font-medium text-ink-2 mb-1">
              Upstream Model ID (Private backend model string)
            </label>
            <input
              type="text"
              required
              placeholder="e.g. gpt-5.6-sol, deepseek-v4-flash, claude-3-5-sonnet"
              value={upstreamModelId}
              onChange={(e) => setUpstreamModelId(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-ink outline-none focus:border-accent font-mono"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block font-medium text-ink-2 mb-1">
                Priority (1 = Primary, 2+ = Fallback)
              </label>
              <input
                type="number"
                min={1}
                required
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-ink outline-none focus:border-accent font-mono"
              />
            </div>
            <div>
              <label className="block font-medium text-ink-2 mb-1">Weight (For tie-breaking)</label>
              <input
                type="number"
                min={1}
                value={weight}
                onChange={(e) => setWeight(Number(e.target.value))}
                className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-ink outline-none focus:border-accent font-mono"
              />
            </div>
          </div>

          <div className="pt-1">
            <label className="flex items-center gap-2 text-ink">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span>Route is enabled</span>
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-line">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-line px-3 py-1.5 text-ink-2 hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-accent px-4 py-1.5 font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : isNew ? 'Create Route' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
