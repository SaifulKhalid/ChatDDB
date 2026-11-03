/**
 * Central Multi-AI Orchestrator for ChatDDB.
 *
 * Implements the core architecture:
 *   AI SERVICE -> ROUTE -> API PROVIDER -> UPSTREAM MODEL
 *
 * Responsibilities:
 *  - Dynamic service discovery and capability matching
 *  - Priority-based route ordering (priority 1 before 2)
 *  - Capability-aware filtering (vision, documents, reasoning, tools)
 *  - Circuit breaker enforcement and health state recording
 *  - Silent priority failover BEFORE streaming starts
 *  - Strict public boundary: never reveals internal routing mechanics to public callers
 */

import type { WorkerEnv } from './env.ts'
import {
  getHealthMap,
  getServiceById,
  getServiceByKey,
  isServiceLive,
  listLiveServices,
  listProviders,
  listRoutes,
  parseCapabilities,
  recordRouteFailure,
  recordRouteSuccess,
  type AiRouteRow,
  type AiServiceRow,
  type ApiProviderRow,
  type RouteHealthRow,
} from './db/aiRouting.ts'
import type { ChatMessage, ProviderAdapter, ProviderCredentials, ToolDefinition } from './adapters/types.ts'
import { OpenAICompatibleAdapter } from './adapters/openai.ts'
import { ClassifiedUpstreamError } from './adapters/errors.ts'
import { ApiError, badRequest } from './lib/http.ts'

const openAIAdapter = new OpenAICompatibleAdapter()

/**
 * Maps a stored provider `adapter` string to an implementation.
 *
 * ## Why unknown values throw instead of defaulting
 *
 * This used to be `case 'openai': default: return openAIAdapter`, so a typo — or
 * an adapter added to the admin UI before its implementation shipped — silently
 * routed the provider's traffic to the OpenAI-compatible client. The failure
 * that produces is the worst kind: a request that goes to a real, billable
 * endpoint with the wrong wire format, returns a provider-shaped 4xx, and looks
 * like an upstream outage rather than a configuration error. The circuit breaker
 * then trips a route that was never actually unhealthy.
 *
 * An unrecognised adapter is a server-side configuration fault, so it is raised
 * as an `ApiError` (the only shape `errorResponse` renders; anything else is
 * flattened to an opaque 500). The public message is deliberately generic — the
 * adapter string and the supported list are internal architecture, and
 * `orchestrateChat` reaches this from ordinary user traffic. The detail goes to
 * the log, where the operator can see it, and the admin panel already shows the
 * offending `adapter` on the provider row.
 */
export function getAdapter(adapterName: string): ProviderAdapter {
  switch (adapterName.toLowerCase()) {
    case 'openai':
      return openAIAdapter
    default:
      console.error(
        '[chatddb] unsupported provider adapter "%s" — expected one of: openai',
        adapterName,
      )
      throw new ApiError(
        500,
        'unsupported_adapter',
        'This AI service is misconfigured and cannot be used. Check the provider adapter in the admin panel.',
      )
  }
}

export interface OrchestrationInput {
  serviceOrKey?: string
  content?: string
  messages: ChatMessage[]
  hasImages?: boolean
  tools?: ToolDefinition[]
  clientSignal: AbortSignal
}

export interface OrchestratedResult {
  res: Response
  service: AiServiceRow
  route: AiRouteRow
  provider: ApiProviderRow
  upstreamModelId: string
  latencyMs: number
}

// ---------------------------------------------------------------------------
// Service Resolution & Auto-Routing
// ---------------------------------------------------------------------------

const LEGACY_SERVICE_MAP: Record<string, string> = {
  // ChatGPT aliases
  'chatgpt-5.6': 'chatgpt',
  'gpt-5.6-sol': 'chatgpt',
  gpt: 'chatgpt',
  chatgpt: 'chatgpt',
  // Gemini aliases
  'gemini-3.7': 'gemini',
  'gemini-3.7-flash': 'gemini',
  gemini: 'gemini',
  // Claude aliases
  'claude-5': 'claude',
  'claude-opus-5': 'claude',
  claude: 'claude',
  // DeepSeek aliases
  'deepseek-v4-flash': 'deepseek',
  deepseek: 'deepseek',
  // GLM aliases
  'glm-5.3': 'glm',
  glm: 'glm',
  // Grok aliases
  grok: 'grok',
}

/**
 * Resolves an AI service from requested key or 'auto'.
 */
export async function resolveService(
  db: D1Database | undefined,
  env: WorkerEnv,
  requestedKey?: string | null,
  input?: { content?: string; hasImages?: boolean },
): Promise<AiServiceRow> {
  const req = requestedKey?.trim().toLowerCase()

  if (req && req !== 'auto') {
    const normalizedKey = LEGACY_SERVICE_MAP[req] || req
    const service = await getServiceByKey(db, normalizedKey)
    if (service && service.enabled === 1) {
      const live = await isServiceLive(db, service.id)
      if (!live) {
        throw badRequest(
          `AI service "${service.public_name}" is currently unavailable.`,
          'service_unavailable',
        )
      }
      return service
    }
    // Also try looking up by ID
    const byId = await getServiceById(db, req)
    if (byId && byId.enabled === 1) {
      const live = await isServiceLive(db, byId.id)
      if (!live) {
        throw badRequest(
          `AI service "${byId.public_name}" is currently unavailable.`,
          'service_unavailable',
        )
      }
      return byId
    }

    throw badRequest(
      `AI service "${requestedKey}" is currently unavailable or unknown.`,
      'unknown_service',
    )
  }

  // Auto routing mode
  return routeAutoService(db, env, input)
}

/**
 * Auto-mode: dynamically determines the most appropriate enabled and live AI service.
 */
async function routeAutoService(
  db: D1Database | undefined,
  _env: WorkerEnv,
  input?: { content?: string; hasImages?: boolean },
): Promise<AiServiceRow> {
  const services = await listLiveServices(db)
  if (services.length === 0) {
    throw badRequest('No AI services are currently available.', 'no_active_services')
  }

  const find = (k: string) => services.find((s) => s.key === k)

  // 1. Vision requests require a vision-capable service
  if (input?.hasImages) {
    const visionService = services.find((s) => parseCapabilities(s.capabilities).vision === true)
    if (visionService) return visionService
  }

  const text = (input?.content ?? '').trim()

  // 2. Multilingual tasks
  const hasNonAscii = Array.from(text).some((c) => c.charCodeAt(0) > 127)
  const isTranslation = /\b(translate|translation|in french|in spanish|in german|in japanese|in chinese|in arabic)\b/i.test(
    text,
  )
  if (hasNonAscii || isTranslation) {
    const gemini = find('gemini')
    if (gemini) return gemini
    const glm = find('glm')
    if (glm) return glm
  }

  // 3. Coding tasks
  const isCoding =
    /```|\b(function|def|class|import|const|let|var|return|async|await|git|docker|sql|query|api|endpoint|regex|html|css|react|typescript|python|javascript|rust|golang|c\+\+|java|bug|debug|refactor|syntax|exception|stacktrace|compile|error|algorithm|database)\b/i.test(
      text,
    )
  if (isCoding) {
    const chatgpt = find('chatgpt')
    if (chatgpt) return chatgpt
    const deepseek = find('deepseek')
    if (deepseek) return deepseek
  }

  // 4. Creative prose / writing
  const isWriting = /\b(essay|critique|prose|draft|tone|nuance|creative writing|poem|poetry|story|novel)\b/i.test(
    text,
  )
  if (isWriting) {
    const claude = find('claude')
    if (claude) return claude
  }

  // 5. Complex reasoning / logic / math
  const isComplexReasoning =
    /\b(prove|proof|theorem|derive|derivation|integral|derivative|calculus|equation|formula|matrix|eigenvalue|step-by-step reasoning|logic puzzle|chain of thought)\b/i.test(
      text,
    ) || /\$\$|\\\[/.test(text)
  if (isComplexReasoning) {
    const glm = find('glm')
    if (glm) return glm
    const chatgpt = find('chatgpt')
    if (chatgpt) return chatgpt
  }

  // Default service or first available
  const defaultSrv = services.find((s) => s.default_service === 1)
  return defaultSrv ?? services[0]
}

// ---------------------------------------------------------------------------
// Route Resolution & Filtering
// ---------------------------------------------------------------------------

export interface RouteCandidate {
  route: AiRouteRow
  provider: ApiProviderRow
  health?: RouteHealthRow | null
}

/**
 * Resolves all eligible candidate routes for an AI service, ordered by priority.
 *
 * ## Why there is no document filter
 *
 * `routes/chat.ts` does not send PDFs to a route as a document part. It extracts
 * the text and prepends it to the turn's content (`withDocuments`), so a PDF
 * reaches the upstream as ordinary text and every route handles it equally well.
 * A `hasDocuments` requirement was threaded through here and never consulted,
 * which read as though document-capable routes were being filtered when the
 * question does not arise. The parameter is gone rather than implemented: there
 * is nothing to filter on.
 *
 * Vision is the opposite case and is filtered below, because image bytes really
 * are sent as image parts and a route that cannot parse them fails upstream.
 */
export async function resolveEligibleRoutes(
  db: D1Database | undefined,
  serviceId: string,
  requirements: { hasImages?: boolean },
): Promise<RouteCandidate[]> {
  const routes = await listRoutes(db, { serviceId, enabledOnly: true })
  if (routes.length === 0) return []

  const providers = await listProviders(db, true)
  const providerMap = new Map<string, ApiProviderRow>()
  for (const p of providers) {
    providerMap.set(p.id, p)
  }

  const healthMap = await getHealthMap(db)
  const candidates: RouteCandidate[] = []

  for (const r of routes) {
    const provider = providerMap.get(r.provider_id)
    if (!provider || provider.enabled !== 1) continue

    const caps = parseCapabilities(r.capabilities)

    if (requirements.hasImages && caps.vision !== true) {
      // Skip routes that cannot handle images when images are present
      continue
    }

    const health = healthMap.get(r.id) ?? null
    candidates.push({ route: r, provider, health })
  }

  // Primary ordering is `priority` ASC (1 is attempted first). `weight` only
  // breaks a tie *within* one priority level, so it never lets a later-priority
  // route jump ahead of an earlier one. See `listRoutes`' doc for why weight is
  // not a load-balancing knob.
  candidates.sort((a, b) => {
    if (a.route.priority !== b.route.priority) {
      return a.route.priority - b.route.priority
    }
    return b.route.weight - a.route.weight
  })

  return candidates
}

/**
 * Filters and reorders routes taking active circuit breakers into consideration.
 */
export function applyCircuitBreakers(candidates: RouteCandidate[]): RouteCandidate[] {
  if (candidates.length <= 1) return candidates

  const now = Date.now()
  const activeRoutes: RouteCandidate[] = []
  const circuitTrippedRoutes: RouteCandidate[] = []

  for (const c of candidates) {
    const isCircuitTripped = Boolean(
      c.health?.circuit_until && c.health.circuit_until > now,
    )
    if (isCircuitTripped) {
      circuitTrippedRoutes.push(c)
    } else {
      activeRoutes.push(c)
    }
  }

  // If all eligible routes are circuit-tripped, keep the one with the earliest recovery time
  // rather than failing outright.
  if (activeRoutes.length === 0) {
    circuitTrippedRoutes.sort(
      (a, b) => (a.health?.circuit_until ?? 0) - (b.health?.circuit_until ?? 0),
    )
    return circuitTrippedRoutes
  }

  // Put healthy active routes first, followed by recovering routes as emergency fallbacks
  return [...activeRoutes, ...circuitTrippedRoutes]
}

// ---------------------------------------------------------------------------
// Credentials Resolution
// ---------------------------------------------------------------------------

export function resolveProviderCredentials(
  provider: ApiProviderRow,
  env: WorkerEnv,
): ProviderCredentials {
  let dbCreds: ProviderCredentials = {}
  if (provider.credentials) {
    try {
      dbCreds = JSON.parse(provider.credentials) as ProviderCredentials
    } catch {
      dbCreds = {}
    }
  }

  const keys: string[] = []
  if (dbCreds.apiKeys && Array.isArray(dbCreds.apiKeys)) {
    keys.push(...dbCreds.apiKeys.filter(Boolean))
  }
  if (dbCreds.apiKey?.trim()) {
    keys.push(dbCreds.apiKey.trim())
  }

  // If no DB keys exist, check environment variables based on provider key
  if (keys.length === 0) {
    if (provider.key === 'codecraft') {
      const ccKey = env.CODECRAFT_API_KEY?.trim()
      if (ccKey && ccKey !== 'cc-replace-me' && ccKey !== 'sk-replace-me') {
        keys.push(ccKey.replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, ''))
      }
    } else if (provider.key === 'agentrouter') {
      const candidates = [
        env.AGENTROUTER_API_KEY,
        env.AGENTROUTER_API_KEY_2,
        env.AGENTROUTER_API_KEY_3,
      ]
      for (const cand of candidates) {
        const trimmed = cand?.trim()
        if (trimmed && trimmed !== 'sk-replace-me' && !keys.includes(trimmed)) {
          keys.push(trimmed)
        }
      }
    }
  }

  return {
    apiKey: keys[0],
    apiKeys: keys,
  }
}

// ---------------------------------------------------------------------------
// Orchestrator Execution Loop
// ---------------------------------------------------------------------------

/**
 * Executes a chat request through the hidden multi-AI orchestrator with
 * automated priority failover and circuit breaking.
 */
export async function orchestrateChat(
  db: D1Database | undefined,
  env: WorkerEnv,
  input: OrchestrationInput,
): Promise<OrchestratedResult> {
  const service = await resolveService(db, env, input.serviceOrKey, {
    content: input.content,
    hasImages: input.hasImages,
  })

  const rawCandidates = await resolveEligibleRoutes(db, service.id, {
    hasImages: input.hasImages,
  })

  if (rawCandidates.length === 0) {
    throw badRequest(
      `${service.public_name} has no available routes that meet the request requirements.`,
      'no_eligible_routes',
    )
  }

  const orderedCandidates = applyCircuitBreakers(rawCandidates)
  let lastError: ClassifiedUpstreamError | null = null

  for (let idx = 0; idx < orderedCandidates.length; idx++) {
    const candidate = orderedCandidates[idx]
    const { route, provider } = candidate
    const creds = resolveProviderCredentials(provider, env)
    const adapter = getAdapter(provider.adapter)

    let routeConfig: {
      tokenParam?: 'max_tokens' | 'max_completion_tokens'
      maxOutputTokens?: number
      reasoningEffort?: string
      sendReasoningEffort?: boolean
    } = {}

    if (route.configuration) {
      try {
        routeConfig = JSON.parse(route.configuration) as typeof routeConfig
      } catch {
        routeConfig = {}
      }
    }

    const startTime = Date.now()

    try {
      const res = await adapter.executeChat(provider, creds, {
        upstreamModel: route.upstream_model_id,
        messages: input.messages,
        clientSignal: input.clientSignal,
        tools: input.tools,
        configuration: routeConfig,
        timeoutMs: provider.timeout_ms,
      })

      const latencyMs = Date.now() - startTime

      // Record successful attempt in background
      void recordRouteSuccess(db, route.id, latencyMs).catch((e) => {
        console.warn(`[orchestrator] failed to record route success for ${route.id}:`, e)
      })

      return {
        res,
        service,
        route,
        provider,
        upstreamModelId: route.upstream_model_id,
        latencyMs,
      }
    } catch (err) {
      const latencyMs = Date.now() - startTime

      if (input.clientSignal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }

      const classifiedErr =
        err instanceof ClassifiedUpstreamError
          ? err
          : new ClassifiedUpstreamError({
              publicStatus: 502,
              category: 'route_failure',
              crossable: true,
              publicMessage: `${service.public_name} is temporarily unavailable.`,
              internalDiagnostic: `[${provider.label}] route error: ${err instanceof Error ? err.message : String(err)}`,
            })

      lastError = classifiedErr

      // Record failure and trip circuit breaker after 3 consecutive failures
      const consecutive = (candidate.health?.consecutive_failures ?? 0) + 1
      const tripCircuit = consecutive >= 3
      void recordRouteFailure(
        db,
        route.id,
        latencyMs,
        classifiedErr.classification.category,
        classifiedErr.classification.internalDiagnostic,
        tripCircuit,
        120000, // 2-minute circuit trip
      ).catch((e) => {
        console.warn(`[orchestrator] failed to record route failure for ${route.id}:`, e)
      })

      console.warn(
        `[orchestrator] route failed: service=${service.public_name} priority=${route.priority} provider=${provider.label} model=${route.upstream_model_id} error=${classifiedErr.classification.category}`,
      )

      // If crossable and more candidate routes are available, proceed to next priority route
      if (classifiedErr.classification.crossable && idx < orderedCandidates.length - 1) {
        continue
      }

      throw classifiedErr
    }
  }

  throw (
    lastError ??
    new ClassifiedUpstreamError({
      publicStatus: 502,
      category: 'all_routes_failed',
      crossable: false,
      publicMessage: `${service.public_name} is currently unavailable. Please try again shortly.`,
      internalDiagnostic: `All ${orderedCandidates.length} routes failed for ${service.key}`,
    })
  )
}
