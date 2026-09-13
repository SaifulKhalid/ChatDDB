/**
-- ChatDDB Hidden Multi-AI Aggregation Platform
 * Database helpers for ai_services, api_providers, ai_routes, and route_health.
 */

import { newId } from '../lib/hash.ts'
import { all, first, run, requireDb } from './client.ts'

export interface ServiceCapabilities {
  vision?: boolean
  documents?: boolean
  reasoning?: boolean
  tools?: boolean
  [key: string]: unknown
}

export interface AiServiceRow {
  id: string
  key: string
  public_name: string
  description: string | null
  capabilities: string // JSON
  enabled: number // 1 or 0
  default_service: number // 1 or 0
  sort_order: number
  created_at: number
  updated_at: number
}

export interface ApiProviderRow {
  id: string
  key: string
  label: string
  adapter: string
  base_url: string
  credentials: string // JSON: {"apiKey": "..."} or {"apiKeys": ["..."]}
  headers: string | null // JSON
  timeout_ms: number
  enabled: number // 1 or 0
  created_at: number
  updated_at: number
}

export interface AiRouteRow {
  id: string
  service_id: string
  provider_id: string
  upstream_model_id: string
  priority: number
  weight: number
  enabled: number // 1 or 0
  capabilities: string | null // JSON override
  configuration: string | null // JSON override
  created_at: number
  updated_at: number
}

export interface RouteHealthRow {
  route_id: string
  consecutive_failures: number
  last_success_at: number | null
  last_failure_at: number | null
  last_latency_ms: number | null
  last_error_class: string | null
  last_error_message: string | null
  circuit_until: number | null
  updated_at: number
}

// ---------------------------------------------------------------------------
// Secret Masking Helper
// ---------------------------------------------------------------------------

export function maskSecret(secret: string | undefined | null): string {
  if (!secret) return ''
  const trimmed = secret.trim()
  if (trimmed.length <= 8) return '••••••••'
  return `••••••••${trimmed.slice(-4)}`
}

export function maskCredentialsJson(rawJson: string | null | undefined): {
  maskedKey: string
  hasKey: boolean
} {
  if (!rawJson) return { maskedKey: '', hasKey: false }
  try {
    const creds = JSON.parse(rawJson) as { apiKey?: string; apiKeys?: string[] }
    const key = creds.apiKey || (creds.apiKeys && creds.apiKeys[0])
    if (!key) return { maskedKey: '', hasKey: false }
    return {
      maskedKey: maskSecret(key),
      hasKey: true,
    }
  } catch {
    return { maskedKey: '', hasKey: false }
  }
}

// ---------------------------------------------------------------------------
// AI Services
// ---------------------------------------------------------------------------

export async function listServices(
  db: D1Database | undefined,
  includeDisabled = false,
): Promise<AiServiceRow[]> {
  const d1 = requireDb(db)
  const sql = includeDisabled
    ? 'SELECT * FROM ai_services ORDER BY sort_order ASC, public_name ASC'
    : 'SELECT * FROM ai_services WHERE enabled = 1 ORDER BY sort_order ASC, public_name ASC'
  return all<AiServiceRow>(d1, sql)
}

export async function getServiceById(
  db: D1Database | undefined,
  id: string,
): Promise<AiServiceRow | null> {
  const d1 = requireDb(db)
  return first<AiServiceRow>(d1, 'SELECT * FROM ai_services WHERE id = ?', id)
}

export async function getServiceByKey(
  db: D1Database | undefined,
  key: string,
): Promise<AiServiceRow | null> {
  const d1 = requireDb(db)
  return first<AiServiceRow>(d1, 'SELECT * FROM ai_services WHERE key = ?', key)
}

export async function getDefaultService(
  db: D1Database | undefined,
): Promise<AiServiceRow | null> {
  const d1 = requireDb(db)
  const explicit = await first<AiServiceRow>(
    d1,
    'SELECT * FROM ai_services WHERE default_service = 1 AND enabled = 1 LIMIT 1',
  )
  if (explicit) return explicit
  return first<AiServiceRow>(
    d1,
    'SELECT * FROM ai_services WHERE enabled = 1 ORDER BY sort_order ASC LIMIT 1',
  )
}

/**
 * Returns only the AI services that are currently enabled, have enabled routes with enabled providers,
 * and whose computed health status is NOT 'down' (i.e. at least one healthy/eligible route).
 */
export async function listLiveServices(
  db: D1Database | undefined,
): Promise<AiServiceRow[]> {
  const d1 = requireDb(db)
  const [services, routes, providers, healthMap] = await Promise.all([
    listServices(d1, false), // enabled = 1
    listRoutes(d1, { enabledOnly: true }), // route enabled = 1
    listProviders(d1, false), // provider enabled = 1
    getHealthMap(d1),
  ])

  const enabledProviderIds = new Set(providers.map((p) => p.id))

  const live = services.filter((srv) => {
    // Find enabled routes for this service where the provider is also enabled
    const srvRoutes = routes.filter(
      (r) => r.service_id === srv.id && enabledProviderIds.has(r.provider_id),
    )
    if (srvRoutes.length === 0) return false

    const routesWithHealth = srvRoutes.map((r) => ({
      enabled: r.enabled,
      priority: r.priority,
      health: healthMap.get(r.id) ?? null,
    }))

    const status = computeServiceStatus(routesWithHealth)
    return status !== 'down'
  })

  return live
}

export async function isServiceLive(
  db: D1Database | undefined,
  serviceIdOrKey: string,
): Promise<boolean> {
  const live = await listLiveServices(db)
  return live.some((s) => s.id === serviceIdOrKey || s.key === serviceIdOrKey.toLowerCase())
}

export async function createService(
  db: D1Database | undefined,
  input: {
    key: string
    publicName: string
    description?: string | null
    capabilities?: ServiceCapabilities
    enabled?: boolean
    defaultService?: boolean
    sortOrder?: number
  },
): Promise<AiServiceRow> {
  const d1 = requireDb(db)
  const id = newId()
  const now = Date.now()
  const caps = JSON.stringify(input.capabilities ?? {})

  if (input.defaultService) {
    await run(d1, 'UPDATE ai_services SET default_service = 0')
  }

  await run(
    d1,
    `INSERT INTO ai_services (id, key, public_name, description, capabilities, enabled, default_service, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.key.trim().toLowerCase(),
      input.publicName.trim(),
      input.description?.trim() || null,
      caps,
      input.enabled === false ? 0 : 1,
      input.defaultService ? 1 : 0,
      input.sortOrder ?? 0,
      now,
      now,
    ],
  )

  const row = await getServiceById(db, id)
  if (!row) throw new Error('Failed to create AI service')
  return row
}

export async function updateService(
  db: D1Database | undefined,
  id: string,
  input: {
    key?: string
    publicName?: string
    description?: string | null
    capabilities?: ServiceCapabilities
    enabled?: boolean
    defaultService?: boolean
    sortOrder?: number
  },
): Promise<AiServiceRow | null> {
  const d1 = requireDb(db)
  const existing = await getServiceById(db, id)
  if (!existing) return null

  const now = Date.now()

  if (input.defaultService) {
    await run(d1, 'UPDATE ai_services SET default_service = 0 WHERE id != ?', [id])
  }

  const newKey = input.key !== undefined ? input.key.trim().toLowerCase() : existing.key
  const newName = input.publicName !== undefined ? input.publicName.trim() : existing.public_name
  const newDesc = input.description !== undefined ? input.description?.trim() || null : existing.description
  const newCaps = input.capabilities !== undefined ? JSON.stringify(input.capabilities) : existing.capabilities
  const newEnabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled
  const newDefault = input.defaultService !== undefined ? (input.defaultService ? 1 : 0) : existing.default_service
  const newSort = input.sortOrder !== undefined ? input.sortOrder : existing.sort_order

  await run(
    d1,
    `UPDATE ai_services
     SET key = ?, public_name = ?, description = ?, capabilities = ?, enabled = ?, default_service = ?, sort_order = ?, updated_at = ?
     WHERE id = ?`,
    [newKey, newName, newDesc, newCaps, newEnabled, newDefault, newSort, now, id],
  )

  return getServiceById(db, id)
}

export async function deleteService(
  db: D1Database | undefined,
  id: string,
): Promise<boolean> {
  const d1 = requireDb(db)
  const res = await run(d1, 'DELETE FROM ai_services WHERE id = ?', [id])
  return res.meta.changes > 0
}

// ---------------------------------------------------------------------------
// API Providers
// ---------------------------------------------------------------------------

export async function listProviders(
  db: D1Database | undefined,
  includeDisabled = false,
): Promise<ApiProviderRow[]> {
  const d1 = requireDb(db)
  const sql = includeDisabled
    ? 'SELECT * FROM api_providers ORDER BY label ASC'
    : 'SELECT * FROM api_providers WHERE enabled = 1 ORDER BY label ASC'
  return all<ApiProviderRow>(d1, sql)
}

export async function getProviderById(
  db: D1Database | undefined,
  id: string,
): Promise<ApiProviderRow | null> {
  const d1 = requireDb(db)
  return first<ApiProviderRow>(d1, 'SELECT * FROM api_providers WHERE id = ?', id)
}

export async function getProviderByKey(
  db: D1Database | undefined,
  key: string,
): Promise<ApiProviderRow | null> {
  const d1 = requireDb(db)
  return first<ApiProviderRow>(d1, 'SELECT * FROM api_providers WHERE key = ?', key)
}

export async function createProvider(
  db: D1Database | undefined,
  input: {
    key: string
    label: string
    adapter?: string
    baseUrl: string
    apiKey?: string
    apiKeys?: string[]
    headers?: Record<string, string> | null
    timeoutMs?: number
    enabled?: boolean
  },
): Promise<ApiProviderRow> {
  const d1 = requireDb(db)
  const id = newId()
  const now = Date.now()

  let credsObj: Record<string, unknown> = {}
  if (input.apiKeys && input.apiKeys.length > 0) {
    credsObj = { apiKeys: input.apiKeys }
  } else if (input.apiKey) {
    credsObj = { apiKey: input.apiKey.trim() }
  }

  const headersJson = input.headers ? JSON.stringify(input.headers) : null

  await run(
    d1,
    `INSERT INTO api_providers (id, key, label, adapter, base_url, credentials, headers, timeout_ms, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.key.trim().toLowerCase(),
      input.label.trim(),
      input.adapter || 'openai',
      input.baseUrl.trim(),
      JSON.stringify(credsObj),
      headersJson,
      input.timeoutMs ?? 180000,
      input.enabled === false ? 0 : 1,
      now,
      now,
    ],
  )

  const row = await getProviderById(db, id)
  if (!row) throw new Error('Failed to create API provider')
  return row
}

export async function updateProvider(
  db: D1Database | undefined,
  id: string,
  input: {
    key?: string
    label?: string
    adapter?: string
    baseUrl?: string
    apiKey?: string
    apiKeys?: string[]
    headers?: Record<string, string> | null
    timeoutMs?: number
    enabled?: boolean
  },
): Promise<ApiProviderRow | null> {
  const d1 = requireDb(db)
  const existing = await getProviderById(db, id)
  if (!existing) return null

  const now = Date.now()
  const newKey = input.key !== undefined ? input.key.trim().toLowerCase() : existing.key
  const newLabel = input.label !== undefined ? input.label.trim() : existing.label
  const newAdapter = input.adapter !== undefined ? input.adapter : existing.adapter
  const newBaseUrl = input.baseUrl !== undefined ? input.baseUrl.trim() : existing.base_url

  let newCreds = existing.credentials
  if (input.apiKeys && input.apiKeys.length > 0) {
    newCreds = JSON.stringify({ apiKeys: input.apiKeys })
  } else if (input.apiKey !== undefined && input.apiKey.trim().length > 0) {
    newCreds = JSON.stringify({ apiKey: input.apiKey.trim() })
  }

  let newHeaders = existing.headers
  if (input.headers !== undefined) {
    newHeaders = input.headers ? JSON.stringify(input.headers) : null
  }

  const newTimeout = input.timeoutMs !== undefined ? input.timeoutMs : existing.timeout_ms
  const newEnabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled

  await run(
    d1,
    `UPDATE api_providers
     SET key = ?, label = ?, adapter = ?, base_url = ?, credentials = ?, headers = ?, timeout_ms = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
    [newKey, newLabel, newAdapter, newBaseUrl, newCreds, newHeaders, newTimeout, newEnabled, now, id],
  )

  return getProviderById(db, id)
}

export async function deleteProvider(
  db: D1Database | undefined,
  id: string,
): Promise<boolean> {
  const d1 = requireDb(db)
  const res = await run(d1, 'DELETE FROM api_providers WHERE id = ?', [id])
  return res.meta.changes > 0
}

// ---------------------------------------------------------------------------
// AI Routes
// ---------------------------------------------------------------------------

export async function listRoutes(
  db: D1Database | undefined,
  filter?: { serviceId?: string; providerId?: string; enabledOnly?: boolean },
): Promise<AiRouteRow[]> {
  const d1 = requireDb(db)
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter?.serviceId) {
    conditions.push('service_id = ?')
    params.push(filter.serviceId)
  }
  if (filter?.providerId) {
    conditions.push('provider_id = ?')
    params.push(filter.providerId)
  }
  if (filter?.enabledOnly) {
    conditions.push('enabled = 1')
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const sql = `SELECT * FROM ai_routes ${where} ORDER BY service_id ASC, priority ASC, weight DESC`
  return all<AiRouteRow>(d1, sql, ...params)
}

export async function getRouteById(
  db: D1Database | undefined,
  id: string,
): Promise<AiRouteRow | null> {
  const d1 = requireDb(db)
  return first<AiRouteRow>(d1, 'SELECT * FROM ai_routes WHERE id = ?', id)
}

export async function createRoute(
  db: D1Database | undefined,
  input: {
    serviceId: string
    providerId: string
    upstreamModelId: string
    priority?: number
    weight?: number
    enabled?: boolean
    capabilities?: Record<string, unknown> | null
    configuration?: Record<string, unknown> | null
  },
): Promise<AiRouteRow> {
  const d1 = requireDb(db)
  const id = newId()
  const now = Date.now()

  await run(
    d1,
    `INSERT INTO ai_routes (id, service_id, provider_id, upstream_model_id, priority, weight, enabled, capabilities, configuration, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.serviceId,
      input.providerId,
      input.upstreamModelId.trim(),
      input.priority ?? 1,
      input.weight ?? 100,
      input.enabled === false ? 0 : 1,
      input.capabilities ? JSON.stringify(input.capabilities) : null,
      input.configuration ? JSON.stringify(input.configuration) : null,
      now,
      now,
    ],
  )

  const row = await getRouteById(db, id)
  if (!row) throw new Error('Failed to create route')
  return row
}

export async function updateRoute(
  db: D1Database | undefined,
  id: string,
  input: {
    serviceId?: string
    providerId?: string
    upstreamModelId?: string
    priority?: number
    weight?: number
    enabled?: boolean
    capabilities?: Record<string, unknown> | null
    configuration?: Record<string, unknown> | null
  },
): Promise<AiRouteRow | null> {
  const d1 = requireDb(db)
  const existing = await getRouteById(db, id)
  if (!existing) return null

  const now = Date.now()
  const newServiceId = input.serviceId !== undefined ? input.serviceId : existing.service_id
  const newProviderId = input.providerId !== undefined ? input.providerId : existing.provider_id
  const newModelId = input.upstreamModelId !== undefined ? input.upstreamModelId.trim() : existing.upstream_model_id
  const newPriority = input.priority !== undefined ? input.priority : existing.priority
  const newWeight = input.weight !== undefined ? input.weight : existing.weight
  const newEnabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled
  const newCaps = input.capabilities !== undefined ? (input.capabilities ? JSON.stringify(input.capabilities) : null) : existing.capabilities
  const newConfig = input.configuration !== undefined ? (input.configuration ? JSON.stringify(input.configuration) : null) : existing.configuration

  await run(
    d1,
    `UPDATE ai_routes
     SET service_id = ?, provider_id = ?, upstream_model_id = ?, priority = ?, weight = ?, enabled = ?, capabilities = ?, configuration = ?, updated_at = ?
     WHERE id = ?`,
    [newServiceId, newProviderId, newModelId, newPriority, newWeight, newEnabled, newCaps, newConfig, now, id],
  )

  return getRouteById(db, id)
}

export async function deleteRoute(
  db: D1Database | undefined,
  id: string,
): Promise<boolean> {
  const d1 = requireDb(db)
  const res = await run(d1, 'DELETE FROM ai_routes WHERE id = ?', [id])
  return res.meta.changes > 0
}

// ---------------------------------------------------------------------------
// Route Health & Circuit Breaker
// ---------------------------------------------------------------------------

export async function getRouteHealth(
  db: D1Database | undefined,
  routeId: string,
): Promise<RouteHealthRow | null> {
  const d1 = requireDb(db)
  return first<RouteHealthRow>(d1, 'SELECT * FROM route_health WHERE route_id = ?', routeId)
}

export async function getHealthMap(
  db: D1Database | undefined,
): Promise<Map<string, RouteHealthRow>> {
  const d1 = requireDb(db)
  const rows = await all<RouteHealthRow>(d1, 'SELECT * FROM route_health')
  const map = new Map<string, RouteHealthRow>()
  for (const row of rows) {
    map.set(row.route_id, row)
  }
  return map
}

export async function recordRouteSuccess(
  db: D1Database | undefined,
  routeId: string,
  latencyMs: number,
): Promise<void> {
  const d1 = requireDb(db)
  const now = Date.now()

  await run(
    d1,
    `INSERT INTO route_health (route_id, consecutive_failures, last_success_at, last_latency_ms, circuit_until, updated_at)
     VALUES (?, 0, ?, ?, NULL, ?)
     ON CONFLICT (route_id) DO UPDATE SET
       consecutive_failures = 0,
       last_success_at = excluded.last_success_at,
       last_latency_ms = excluded.last_latency_ms,
       circuit_until = NULL,
       updated_at = excluded.updated_at`,
    [routeId, now, latencyMs, now],
  )
}

export async function recordRouteFailure(
  db: D1Database | undefined,
  routeId: string,
  latencyMs: number | null,
  errorClass: string,
  errorMessage: string,
  tripCircuit = false,
  circuitDurationMs = 60000,
): Promise<void> {
  const d1 = requireDb(db)
  const now = Date.now()
  const circuitUntil = tripCircuit ? now + circuitDurationMs : null

  await run(
    d1,
    `INSERT INTO route_health (route_id, consecutive_failures, last_failure_at, last_latency_ms, last_error_class, last_error_message, circuit_until, updated_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (route_id) DO UPDATE SET
       consecutive_failures = route_health.consecutive_failures + 1,
       last_failure_at = excluded.last_failure_at,
       last_latency_ms = excluded.last_latency_ms,
       last_error_class = excluded.last_error_class,
       last_error_message = excluded.last_error_message,
       circuit_until = CASE WHEN ? IS NOT NULL THEN ? ELSE route_health.circuit_until END,
       updated_at = excluded.updated_at`,
    [
      routeId,
      now,
      latencyMs,
      errorClass,
      errorMessage.slice(0, 500),
      circuitUntil,
      now,
      circuitUntil,
      circuitUntil,
    ],
  )
}

export async function resetRouteHealth(
  db: D1Database | undefined,
  routeId: string,
): Promise<void> {
  const d1 = requireDb(db)
  await run(d1, 'DELETE FROM route_health WHERE route_id = ?', [routeId])
}

// ---------------------------------------------------------------------------
// Service Status Calculation
// ---------------------------------------------------------------------------

export type ServiceStatus = 'operational' | 'degraded' | 'down'

export function computeServiceStatus(
  routes: Array<{ enabled: number; priority: number; health?: RouteHealthRow | null }>,
): ServiceStatus {
  const enabledRoutes = routes.filter((r) => r.enabled === 1)
  if (enabledRoutes.length === 0) return 'down'

  const now = Date.now()
  const isHealthy = (r: { health?: RouteHealthRow | null }) => {
    if (!r.health) return true // Untested is considered eligible/tentatively healthy
    const inCircuit = r.health.circuit_until && r.health.circuit_until > now
    return !inCircuit && r.health.consecutive_failures < 3
  }

  const sorted = [...enabledRoutes].sort((a, b) => a.priority - b.priority)
  const primary = sorted[0]
  const primaryHealthy = primary && isHealthy(primary)

  const anyHealthy = enabledRoutes.some(isHealthy)

  if (primaryHealthy) {
    // Primary is healthy
    const anyFailing = enabledRoutes.some((r) => !isHealthy(r))
    return anyFailing ? 'degraded' : 'operational'
  }

  if (anyHealthy) {
    // Primary failed but backup works
    return 'degraded'
  }

  return 'down'
}
