import React, { useEffect, useState } from 'react'
import { adminApi } from '../../lib/adminApi'
import type { ProviderHealthResponse } from '../../lib/apiTypes'
import { Activity, AlertTriangle, CheckCircle, RefreshCw, Server, Zap } from 'lucide-react'

export function AdminProviderHealth() {
  const [data, setData] = useState<ProviderHealthResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadHealth = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await adminApi.providerHealth()
      setData(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load provider health.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadHealth()
  }, [])

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">AI Provider Health</h2>
          <p className="text-xs text-ink-2">
            Two-provider architecture (AgentRouter &amp; ApiNex) with in-memory circuit breakers and pre-stream silent failover.
          </p>
        </div>
        <button
          onClick={loadHealth}
          disabled={loading}
          className="inline-flex items-center gap-1.5 self-start rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          <span>{loading ? 'Refreshing…' : 'Refresh Status'}</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      )}

      {/* Providers Grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {data &&
          (['agentrouter', 'apinex'] as const).map((key) => {
            const prov = data.providers[key]
            const circuits = Object.entries(data.circuits).filter(([k]) => k.startsWith(`${key}:`))

            return (
              <div
                key={key}
                className="flex flex-col justify-between rounded-xl border border-line bg-surface-1 p-5 shadow-sm"
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Server size={18} className="text-ink-2" />
                      <h3 className="font-semibold text-ink">{prov.label}</h3>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        prov.configured
                          ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20'
                          : 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
                      }`}
                    >
                      {prov.configured ? (
                        <>
                          <CheckCircle size={12} /> Configured ({prov.keysCount} key{prov.keysCount !== 1 ? 's' : ''})
                        </>
                      ) : (
                        <>
                          <AlertTriangle size={12} /> No Keys Set
                        </>
                      )}
                    </span>
                  </div>

                  <div className="space-y-1 text-xs text-ink-2">
                    <div className="flex justify-between py-1 border-b border-line/50">
                      <span>Base URL</span>
                      <code className="text-ink font-mono">{prov.baseUrl}</code>
                    </div>
                    <div className="flex justify-between py-1 border-b border-line/50">
                      <span>Wire Protocol</span>
                      <span className="font-medium text-ink uppercase tracking-wider text-[11px]">
                        {prov.protocol === 'responses' ? 'OpenAI Responses API' : 'Chat Completions API'}
                      </span>
                    </div>
                    <div className="flex justify-between py-1">
                      <span>Rotated Keys</span>
                      <span className="font-mono text-ink">{prov.keysCount} active</span>
                    </div>
                  </div>
                </div>

                {/* Breakers status for provider */}
                <div className="mt-4 rounded-lg bg-surface-2 p-3 text-xs">
                  <div className="flex items-center gap-1.5 font-medium text-ink mb-2">
                    <Zap size={13} className="text-ink-2" />
                    <span>Circuit Breakers</span>
                  </div>
                  {circuits.length === 0 ? (
                    <p className="text-ink-2 italic">No active failures recorded in this isolate.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {circuits.map(([targetKey, cb]) => (
                        <div key={targetKey} className="flex items-center justify-between font-mono text-[11px]">
                          <span>{targetKey.split(':')[1]}</span>
                          <span
                            className={
                              cb.isOpen
                                ? 'text-red-500 font-semibold'
                                : cb.consecutiveFailures > 0
                                ? 'text-amber-500'
                                : 'text-emerald-500'
                            }
                          >
                            {cb.isOpen
                              ? `TRIPPED (${Math.max(0, Math.round((cb.openUntil - Date.now()) / 1000))}s left)`
                              : `${cb.consecutiveFailures} fail(s)`}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
      </div>

      {/* Model Catalog & Fallover Ladders */}
      <div className="rounded-xl border border-line bg-surface-1 p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-2">
          <Activity size={18} className="text-ink-2" />
          <h3 className="font-semibold text-ink">Catalog &amp; Failover Ladders</h3>
        </div>
        <p className="text-xs text-ink-2">
          Model resolution is 100% static and reads zero D1 rows. Upstream failures fail over sequentially before the first byte is streamed to the user.
        </p>

        <div className="divide-y divide-line/60 rounded-lg border border-line bg-surface-2/40 overflow-hidden">
          {data?.models.map((m) => (
            <div key={m.publicKey} className="p-4 space-y-2">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                <div>
                  <span className="font-semibold text-sm text-ink">{m.name}</span>
                  <code className="ml-2 text-xs text-ink-2 font-mono">({m.publicKey})</code>
                </div>
                {m.description && <span className="text-xs text-ink-2">{m.description}</span>}
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-xs font-medium text-ink-2">Priority Ladder:</span>
                {m.targets.map((tgt, idx) => {
                  const circuitKey = `${tgt.provider}:${tgt.upstreamModel}`
                  const circuit = data.circuits[circuitKey]
                  const isTripped = circuit?.isOpen

                  return (
                    <React.Fragment key={circuitKey + idx}>
                      {idx > 0 && <span className="text-xs text-ink-2 font-bold">&rarr;</span>}
                      <span
                        className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-mono ${
                          isTripped
                            ? 'border-red-500/30 bg-red-500/10 text-red-500'
                            : 'border-line bg-surface-1 text-ink'
                        }`}
                      >
                        <span className="font-bold text-[10px] uppercase text-ink-2">{tgt.provider}</span>
                        <span>{tgt.upstreamModel}</span>
                        {isTripped && <span className="text-[10px] uppercase font-bold text-red-500">[Tripped]</span>}
                      </span>
                    </React.Fragment>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg bg-surface-2 p-3 text-xs text-ink-2">
        <strong>Note:</strong> Circuit breakers are maintained in-memory per Cloudflare Worker isolate. A tripped target recovers automatically after 60 seconds.
      </div>
    </div>
  )
}
