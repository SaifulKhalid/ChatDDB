/**
 * Admin API routes for AI Services, API Providers, Routes, and Health Verification.
 *
 * Every route is protected behind `requireAdmin`.
 * Secrets are masked (`••••••••1234`) and never returned in plaintext.
 */

import { badRequest, json, notFound } from '../lib/http.ts'
import { readJsonBody } from '../lib/validate.ts'
import type { AuthedContext } from '../auth/middleware.ts'
import {
  computeServiceStatus,
  createProvider,
  createRoute,
  createService,
  deleteProvider,
  deleteRoute,
  deleteService,
  getHealthMap,
  getProviderById,
  getRouteById,
  listProviders,
  listRoutes,
  listServices,
  maskCredentialsJson,
  recordRouteFailure,
  recordRouteSuccess,
  updateProvider,
  updateRoute,
  updateService,
  type AiRouteRow,
  type AiServiceRow,
  type ApiProviderRow,
  type RouteHealthRow,
  type ServiceCapabilities,
} from '../db/aiRouting.ts'
import { getAdapter, resolveProviderCredentials } from '../orchestrator.ts'

// ---------------------------------------------------------------------------
// AI Services CRUD
// ---------------------------------------------------------------------------

export async function listAdminServices(ctx: AuthedContext): Promise<Response> {
  const services = await listServices(ctx.db, true)
  return json({ services }, 200, ctx.request, ctx.env)
}

export async function createAdminService(ctx: AuthedContext): Promise<Response> {
  const body = (await readJsonBody(ctx.request)) as {
    key?: string
    publicName?: string
    description?: string | null
    capabilities?: ServiceCapabilities
    enabled?: boolean
    defaultService?: boolean
    sortOrder?: number
  }

  if (!body.key || !body.publicName) {
    throw badRequest('`key` and `publicName` are required.')
  }

  const created = await createService(ctx.db, {
    key: body.key,
    publicName: body.publicName,
    description: body.description,
    capabilities: body.capabilities,
    enabled: body.enabled,
    defaultService: body.defaultService,
    sortOrder: body.sortOrder,
  })

  return json({ service: created }, 201, ctx.request, ctx.env)
}

export async function patchAdminService(ctx: AuthedContext, id: string): Promise<Response> {
  const body = (await readJsonBody(ctx.request)) as {
    key?: string
    publicName?: string
    description?: string | null
    capabilities?: ServiceCapabilities
    enabled?: boolean
    defaultService?: boolean
    sortOrder?: number
  }

  const updated = await updateService(ctx.db, id, body)
  if (!updated) throw notFound('AI service not found.')

  return json({ service: updated }, 200, ctx.request, ctx.env)
}

export async function deleteAdminService(ctx: AuthedContext, id: string): Promise<Response> {
  const deleted = await deleteService(ctx.db, id)
  if (!deleted) throw notFound('AI service not found.')

  return json({ ok: true }, 200, ctx.request, ctx.env)
}

// ---------------------------------------------------------------------------
// API Providers CRUD
// ---------------------------------------------------------------------------

export async function listAdminProviders(ctx: AuthedContext): Promise<Response> {
  const providers = await listProviders(ctx.db, true)

  const sanitized = providers.map((p) => {
    const creds = resolveProviderCredentials(p, ctx.env)
    const activeKey = creds.apiKey
    const { maskedKey, hasKey } = maskCredentialsJson(
      activeKey ? JSON.stringify({ apiKey: activeKey }) : p.credentials,
    )

    return {
      id: p.id,
      key: p.key,
      label: p.label,
      adapter: p.adapter,
      baseUrl: p.base_url,
      maskedKey,
      hasKey,
      headers: p.headers ? JSON.parse(p.headers) : null,
      timeoutMs: p.timeout_ms,
      enabled: p.enabled === 1,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    }
  })

  return json({ providers: sanitized }, 200, ctx.request, ctx.env)
}

export async function createAdminProvider(ctx: AuthedContext): Promise<Response> {
  const body = (await readJsonBody(ctx.request)) as {
    key?: string
    label?: string
    adapter?: string
    baseUrl?: string
    apiKey?: string
    apiKeys?: string[]
    headers?: Record<string, string> | null
    timeoutMs?: number
    enabled?: boolean
  }

  if (!body.key || !body.label || !body.baseUrl) {
    throw badRequest('`key`, `label`, and `baseUrl` are required.')
  }

  const created = await createProvider(ctx.db, {
    key: body.key,
    label: body.label,
    adapter: body.adapter || 'openai',
    baseUrl: body.baseUrl,
    apiKey: body.apiKey,
    apiKeys: body.apiKeys,
    headers: body.headers,
    timeoutMs: body.timeoutMs,
    enabled: body.enabled,
  })

  return json({ provider: created }, 201, ctx.request, ctx.env)
}

export async function patchAdminProvider(ctx: AuthedContext, id: string): Promise<Response> {
  const body = (await readJsonBody(ctx.request)) as {
    key?: string
    label?: string
    adapter?: string
    baseUrl?: string
    apiKey?: string
    apiKeys?: string[]
    headers?: Record<string, string> | null
    timeoutMs?: number
    enabled?: boolean
  }

  const updated = await updateProvider(ctx.db, id, body)
  if (!updated) throw notFound('API provider not found.')

  return json({ provider: updated }, 200, ctx.request, ctx.env)
}

export async function deleteAdminProvider(ctx: AuthedContext, id: string): Promise<Response> {
  const deleted = await deleteProvider(ctx.db, id)
  if (!deleted) throw notFound('API provider not found.')

  return json({ ok: true }, 200, ctx.request, ctx.env)
}

export async function testAdminProvider(ctx: AuthedContext, id: string): Promise<Response> {
  const provider = await getProviderById(ctx.db, id)
  if (!provider) throw notFound('API provider not found.')

  const creds = resolveProviderCredentials(provider, ctx.env)
  const adapter = getAdapter(provider.adapter)
  const result = await adapter.testConnection(provider, creds)

  return json({ result }, 200, ctx.request, ctx.env)
}

// ---------------------------------------------------------------------------
// AI Routes CRUD
// ---------------------------------------------------------------------------

export async function listAdminRoutes(ctx: AuthedContext): Promise<Response> {
  const serviceId = ctx.url.searchParams.get('serviceId') || undefined
  const providerId = ctx.url.searchParams.get('providerId') || undefined

  const routes = await listRoutes(ctx.db, { serviceId, providerId })
  return json({ routes }, 200, ctx.request, ctx.env)
}

export async function createAdminRoute(ctx: AuthedContext): Promise<Response> {
  const body = (await readJsonBody(ctx.request)) as {
    serviceId?: string
    providerId?: string
    upstreamModelId?: string
    priority?: number
    weight?: number
    enabled?: boolean
    capabilities?: Record<string, unknown> | null
    configuration?: Record<string, unknown> | null
  }

  if (!body.serviceId || !body.providerId || !body.upstreamModelId) {
    throw badRequest('`serviceId`, `providerId`, and `upstreamModelId` are required.')
  }

  const created = await createRoute(ctx.db, {
    serviceId: body.serviceId,
    providerId: body.providerId,
    upstreamModelId: body.upstreamModelId,
    priority: body.priority,
    weight: body.weight,
    enabled: body.enabled,
    capabilities: body.capabilities,
    configuration: body.configuration,
  })

  return json({ route: created }, 201, ctx.request, ctx.env)
}

export async function patchAdminRoute(ctx: AuthedContext, id: string): Promise<Response> {
  const body = (await readJsonBody(ctx.request)) as {
    serviceId?: string
    providerId?: string
    upstreamModelId?: string
    priority?: number
    weight?: number
    enabled?: boolean
    capabilities?: Record<string, unknown> | null
    configuration?: Record<string, unknown> | null
  }

  const updated = await updateRoute(ctx.db, id, body)
  if (!updated) throw notFound('Route not found.')

  return json({ route: updated }, 200, ctx.request, ctx.env)
}

export async function deleteAdminRoute(ctx: AuthedContext, id: string): Promise<Response> {
  const deleted = await deleteRoute(ctx.db, id)
  if (!deleted) throw notFound('Route not found.')

  return json({ ok: true }, 200, ctx.request, ctx.env)
}

export async function testAdminRoute(ctx: AuthedContext, id: string): Promise<Response> {
  const route = await getRouteById(ctx.db, id)
  if (!route) throw notFound('Route not found.')

  const provider = await getProviderById(ctx.db, route.provider_id)
  if (!provider) throw notFound('Associated provider not found.')

  const creds = resolveProviderCredentials(provider, ctx.env)
  const adapter = getAdapter(provider.adapter)
  const result = await adapter.testRoute(provider, creds, route.upstream_model_id)

  if (result.ok) {
    await recordRouteSuccess(ctx.db, route.id, result.latencyMs)
  } else {
    await recordRouteFailure(
      ctx.db,
      route.id,
      result.latencyMs,
      'test_failed',
      result.error ?? 'Test probe failed',
    )
  }

  return json({ result }, 200, ctx.request, ctx.env)
}

// ---------------------------------------------------------------------------
// Health & Verify All
// ---------------------------------------------------------------------------

export interface RouteVerificationReport {
  routeId: string
  serviceId: string
  serviceName: string
  providerId: string
  providerLabel: string
  upstreamModelId: string
  priority: number
  status: 'healthy' | 'failed'
  latencyMs: number
  lastCheck: number
  error?: string
}

/**
 * `POST /api/admin/verify-all`
 * Verifies every enabled route across every enabled AI service and updates health records.
 */
export async function verifyAllRoutes(ctx: AuthedContext): Promise<Response> {
  const [services, routes, providers] = await Promise.all([
    listServices(ctx.db, false),
    listRoutes(ctx.db, { enabledOnly: true }),
    listProviders(ctx.db, true),
  ])

  const serviceMap = new Map<string, AiServiceRow>()
  for (const s of services) serviceMap.set(s.id, s)

  const providerMap = new Map<string, ApiProviderRow>()
  for (const p of providers) providerMap.set(p.id, p)

  const reports: RouteVerificationReport[] = []
  const now = Date.now()

  // Test routes sequentially or with small concurrency to avoid rate limit spikes
  for (const route of routes) {
    const service = serviceMap.get(route.service_id)
    const provider = providerMap.get(route.provider_id)
    if (!service || !provider || provider.enabled !== 1) continue

    const creds = resolveProviderCredentials(provider, ctx.env)
    const adapter = getAdapter(provider.adapter)

    let report: RouteVerificationReport
    try {
      const result = await adapter.testRoute(provider, creds, route.upstream_model_id)
      if (result.ok) {
        await recordRouteSuccess(ctx.db, route.id, result.latencyMs)
        report = {
          routeId: route.id,
          serviceId: service.id,
          serviceName: service.public_name,
          providerId: provider.id,
          providerLabel: provider.label,
          upstreamModelId: route.upstream_model_id,
          priority: route.priority,
          status: 'healthy',
          latencyMs: result.latencyMs,
          lastCheck: now,
        }
      } else {
        await recordRouteFailure(
          ctx.db,
          route.id,
          result.latencyMs,
          'verification_failed',
          result.error ?? 'Health check probe failed',
        )
        report = {
          routeId: route.id,
          serviceId: service.id,
          serviceName: service.public_name,
          providerId: provider.id,
          providerLabel: provider.label,
          upstreamModelId: route.upstream_model_id,
          priority: route.priority,
          status: 'failed',
          latencyMs: result.latencyMs,
          lastCheck: now,
          error: result.error,
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await recordRouteFailure(ctx.db, route.id, 0, 'network_error', errMsg)
      report = {
        routeId: route.id,
        serviceId: service.id,
        serviceName: service.public_name,
        providerId: provider.id,
        providerLabel: provider.label,
        upstreamModelId: route.upstream_model_id,
        priority: route.priority,
        status: 'failed',
        latencyMs: 0,
        lastCheck: now,
        error: errMsg,
      }
    }
    reports.push(report)
  }

  return json(
    {
      timestamp: now,
      totalChecked: reports.length,
      healthyCount: reports.filter((r) => r.status === 'healthy').length,
      failedCount: reports.filter((r) => r.status === 'failed').length,
      results: reports,
    },
    200,
    ctx.request,
    ctx.env,
  )
}

export interface AdminServiceHealth {
  service: AiServiceRow
  status: 'operational' | 'degraded' | 'down'
  routes: Array<{
    route: AiRouteRow
    provider: { id: string; key: string; label: string }
    health: RouteHealthRow | null
    status: 'healthy' | 'failing' | 'circuit_broken'
  }>
}

/**
 * `GET /api/admin/ai-health`
 * Aggregates all AI services with their route health and calculated statuses.
 */
export async function getAdminAiHealth(ctx: AuthedContext): Promise<Response> {
  const [services, routes, providers, healthMap] = await Promise.all([
    listServices(ctx.db, true),
    listRoutes(ctx.db),
    listProviders(ctx.db, true),
    getHealthMap(ctx.db),
  ])

  const providerMap = new Map<string, ApiProviderRow>()
  for (const p of providers) providerMap.set(p.id, p)

  const now = Date.now()
  const serviceReports: AdminServiceHealth[] = []

  for (const s of services) {
    const serviceRoutes = routes.filter((r) => r.service_id === s.id)
    const routeDetails = serviceRoutes.map((r) => {
      const provider = providerMap.get(r.provider_id)
      const health = healthMap.get(r.id) ?? null
      let status: 'healthy' | 'failing' | 'circuit_broken' = 'healthy'

      if (health) {
        if (health.circuit_until && health.circuit_until > now) {
          status = 'circuit_broken'
        } else if (health.consecutive_failures > 0) {
          status = 'failing'
        }
      }

      return {
        route: r,
        provider: {
          id: provider?.id ?? r.provider_id,
          key: provider?.key ?? 'unknown',
          label: provider?.label ?? 'Unknown Provider',
        },
        health,
        status,
      }
    })

    const status = computeServiceStatus(
      routeDetails.map((rd) => ({
        enabled: rd.route.enabled,
        priority: rd.route.priority,
        health: rd.health,
      })),
    )

    serviceReports.push({
      service: s,
      status,
      routes: routeDetails,
    })
  }

  const overallStatus = serviceReports.every((s) => s.status === 'operational')
    ? 'operational'
    : serviceReports.some((s) => s.status === 'operational' || s.status === 'degraded')
      ? 'degraded'
      : 'down'

  return json(
    {
      overallStatus,
      services: serviceReports,
      timestamp: now,
    },
    200,
    ctx.request,
    ctx.env,
  )
}
