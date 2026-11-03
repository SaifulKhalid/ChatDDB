/**
 * Simplified, zero-database routing layer for ChatDDB.
 *
 * Exactly two upstream providers: AgentRouter and ApiNex.
 * Features:
 *  - Static model resolution from catalog.ts (0 D1 reads)
 *  - Per-isolate in-memory circuit breaker (trips for 60s after 3 failures)
 *  - Last-good API key memory per provider
 *  - Unified callUpstream supporting chat completions and responses API
 *  - Separate 20s TTFB timeout from 180s total timeout
 *  - Pre-first-byte silent failover on crossable errors
 */

import {
  type ModelTarget,
  type ProviderConfig,
  type ProviderKey,
  type PublicModel,
  PROVIDERS,
  resolveModel,
} from './catalog.ts'
import type { ChatMessage, ToolDefinition } from './adapters/types.ts'
import {
  ClassifiedUpstreamError,
  classifyHttpResponse,
  classifyNetworkError,
} from './adapters/errors.ts'
import type { WorkerEnv } from './env.ts'

export interface RouteInput {
  serviceOrKey?: string
  model?: PublicModel
  content?: string
  messages: ChatMessage[]
  hasImages?: boolean
  tools?: ToolDefinition[]
  clientSignal: AbortSignal
  env: WorkerEnv
}

export interface RoutedResult {
  res: Response
  model: PublicModel
  target: ModelTarget
  provider: ProviderConfig
  upstreamModelId: string
  latencyMs: number
}

// ---------------------------------------------------------------------------
// Per-isolate In-Memory State
// ---------------------------------------------------------------------------

interface TargetHealth {
  consecutiveFailures: number
  circuitUntil: number
  lastLatencyMs?: number
}

const healthMap = new Map<string, TargetHealth>()
const lastGoodKeyMap = new Map<ProviderKey, number>()

function targetKey(t: ModelTarget): string {
  return `${t.provider}:${t.upstreamModel}`
}

function isCircuitOpen(t: ModelTarget): boolean {
  const h = healthMap.get(targetKey(t))
  return Boolean(h && h.consecutiveFailures >= 3 && h.circuitUntil > Date.now())
}

function recordSuccess(t: ModelTarget, latencyMs: number): void {
  healthMap.set(targetKey(t), { consecutiveFailures: 0, circuitUntil: 0, lastLatencyMs: latencyMs })
}

function recordFailure(t: ModelTarget): void {
  const k = targetKey(t)
  const current = healthMap.get(k) ?? { consecutiveFailures: 0, circuitUntil: 0 }
  const nextFailures = current.consecutiveFailures + 1
  const trip = nextFailures >= 3
  healthMap.set(k, {
    consecutiveFailures: nextFailures,
    circuitUntil: trip ? Date.now() + 60_000 : current.circuitUntil,
  })
}

export function getCircuitBreakerStatus(): Record<string, { open: boolean; failures: number; circuitUntil: number }> {
  const result: Record<string, { open: boolean; failures: number; circuitUntil: number }> = {}
  for (const [k, v] of healthMap.entries()) {
    result[k] = {
      open: v.consecutiveFailures >= 3 && v.circuitUntil > Date.now(),
      failures: v.consecutiveFailures,
      circuitUntil: v.circuitUntil,
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Keys & Upstream Transport
// ---------------------------------------------------------------------------

export function resolveApiKeys(env: WorkerEnv, providerKey: ProviderKey): string[] {
  const cfg = PROVIDERS[providerKey]
  const keys: string[] = []
  for (const name of cfg.keyEnvNames) {
    const val = (env as unknown as Record<string, unknown>)[name]
    if (typeof val === 'string') {
      const trimmed = val.trim().replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '')
      if (trimmed && trimmed !== 'sk-replace-me' && !keys.includes(trimmed)) {
        keys.push(trimmed)
      }
    }
  }
  return keys
}

export async function callUpstream(
  target: ModelTarget,
  provider: ProviderConfig,
  keys: string[],
  request: {
    messages: ChatMessage[]
    tools?: ToolDefinition[]
    clientSignal: AbortSignal
    ttfbTimeoutMs?: number
    totalTimeoutMs?: number
  },
): Promise<{ res: Response; latencyMs: number }> {
  if (keys.length === 0) {
    throw new ClassifiedUpstreamError({
      publicStatus: 500,
      category: 'not_configured',
      crossable: true,
      publicMessage: `AI provider "${provider.label}" is not configured.`,
      internalDiagnostic: `[${provider.label}] No API keys present in environment`,
    })
  }

  const startIdx = (lastGoodKeyMap.get(provider.key) ?? 0) % keys.length
  const keyOrder = keys.map((_, i) => (startIdx + i) % keys.length)
  const isResponsesApi = provider.protocol === 'responses'
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/${isResponsesApi ? 'responses' : 'chat/completions'}`

  const bodyObj: Record<string, unknown> = {
    model: target.upstreamModel,
    stream: true,
  }

  if (isResponsesApi) {
    bodyObj.input = request.messages
  } else {
    bodyObj.messages = request.messages
  }

  if (request.tools && request.tools.length > 0) {
    bodyObj.tools = request.tools
    bodyObj.tool_choice = 'auto'
  }

  const bodyJson = JSON.stringify(bodyObj)
  let lastError: ClassifiedUpstreamError | null = null

  for (let attempt = 0; attempt < keyOrder.length; attempt++) {
    const keyIdx = keyOrder[attempt]
    const apiKey = keys[keyIdx]

    if (request.clientSignal.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    request.clientSignal.addEventListener('abort', onAbort, { once: true })

    let timedOutOnTtfb = false
    const ttfbTimer = setTimeout(() => {
      timedOutOnTtfb = true
      controller.abort()
    }, request.ttfbTimeoutMs ?? provider.ttfbTimeoutMs ?? 20000)

    const totalTimer = setTimeout(() => {
      controller.abort()
    }, request.totalTimeoutMs ?? provider.totalTimeoutMs ?? 180000)

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...provider.headers,
    }

    const startTime = performance.now()

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: bodyJson,
        signal: controller.signal,
      })

      clearTimeout(ttfbTimer)
      request.clientSignal.removeEventListener('abort', onAbort)
      const latencyMs = Math.round(performance.now() - startTime)

      if (res.ok && res.body) {
        clearTimeout(totalTimer)
        lastGoodKeyMap.set(provider.key, keyIdx)
        return { res, latencyMs }
      }

      clearTimeout(totalTimer)
      const errText = await res.text().catch(() => '')
      let message = errText
      try {
        const j = JSON.parse(errText) as { error?: { message?: string }; message?: string }
        message = j.error?.message ?? j.message ?? errText
      } catch {}

      const classified = classifyHttpResponse(
        res.status,
        { message },
        'AI service',
        provider.label,
        target.upstreamModel,
        res.headers.get('retry-after'),
      )

      lastError = new ClassifiedUpstreamError(classified)

      if ((res.status === 401 || res.status === 429) && attempt < keyOrder.length - 1) {
        console.warn(`[${provider.label}] key rotation: key ${attempt + 1}/${keys.length} got HTTP ${res.status}`)
        continue
      }

      throw lastError
    } catch (err) {
      clearTimeout(ttfbTimer)
      clearTimeout(totalTimer)
      request.clientSignal.removeEventListener('abort', onAbort)

      if (request.clientSignal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }

      if (timedOutOnTtfb) {
        lastError = new ClassifiedUpstreamError({
          publicStatus: 504,
          category: 'ttfb_timeout',
          crossable: true,
          publicMessage: 'The AI model took too long to begin responding. Failing over.',
          internalDiagnostic: `[${provider.label}] TTFB timed out for ${target.upstreamModel}`,
        })
        throw lastError
      }

      if (err instanceof ClassifiedUpstreamError) {
        throw err
      }

      const classified = classifyNetworkError(err, 'AI service', provider.label, target.upstreamModel)
      lastError = new ClassifiedUpstreamError(classified)
      throw lastError
    }
  }

  throw lastError ?? new Error('All keys failed')
}

// ---------------------------------------------------------------------------
// Main Router
// ---------------------------------------------------------------------------

export async function routeChat(input: RouteInput): Promise<RoutedResult> {
  const model = input.model ?? resolveModel(input.serviceOrKey ?? 'chatgpt')

  // Find all candidate targets where provider has keys configured
  const candidateTargets = model.targets.filter((t) => {
    const keys = resolveApiKeys(input.env, t.provider)
    return keys.length > 0
  })

  if (candidateTargets.length === 0) {
    throw new ClassifiedUpstreamError({
      publicStatus: 500,
      category: 'not_configured',
      crossable: false,
      publicMessage: 'No AI providers are configured. Set AGENTROUTER_API_KEY or APINEX_API_KEY.',
      internalDiagnostic: 'Zero configured providers found in environment',
    })
  }

  // Filter out targets with open circuit breakers (skip for 60s)
  const healthy = candidateTargets.filter((t) => !isCircuitOpen(t))
  let orderedTargets = healthy

  // If every target is tripped, pick the one that recovers soonest
  if (healthy.length === 0) {
    orderedTargets = [...candidateTargets].sort((a, b) => {
      const uA = healthMap.get(targetKey(a))?.circuitUntil ?? 0
      const uB = healthMap.get(targetKey(b))?.circuitUntil ?? 0
      return uA - uB
    })
  }

  let lastError: ClassifiedUpstreamError | null = null

  for (let idx = 0; idx < orderedTargets.length; idx++) {
    const target = orderedTargets[idx]
    const provider = PROVIDERS[target.provider]
    const keys = resolveApiKeys(input.env, target.provider)

    try {
      const { res, latencyMs } = await callUpstream(target, provider, keys, {
        messages: input.messages,
        tools: input.tools,
        clientSignal: input.clientSignal,
      })

      recordSuccess(target, latencyMs)
      return {
        res,
        model,
        target,
        provider,
        upstreamModelId: target.upstreamModel,
        latencyMs,
      }
    } catch (err) {
      if (input.clientSignal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }

      const classified =
        err instanceof ClassifiedUpstreamError
          ? err
          : new ClassifiedUpstreamError(
              classifyNetworkError(err, 'AI service', provider.label, target.upstreamModel),
            )

      lastError = classified
      recordFailure(target)

      // Silent failover if error is crossable (network, timeout, 5xx, 429/401) and more targets exist
      if (classified.classification.crossable && idx < orderedTargets.length - 1) {
        console.warn(
          `[routing] target failed, failing over silently: ${provider.label} ${target.upstreamModel} (${classified.classification.category})`,
        )
        continue
      }

      throw classified
    }
  }

  throw (
    lastError ??
    new ClassifiedUpstreamError({
      publicStatus: 502,
      category: 'all_routes_failed',
      crossable: false,
      publicMessage: 'All AI model routes are temporarily unavailable.',
      internalDiagnostic: 'Exhausted all available candidate routes',
    })
  )
}
