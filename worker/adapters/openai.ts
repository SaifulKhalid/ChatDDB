/**
 * OpenAI-compatible upstream provider adapter.
 *
 * Implements communication with OpenAI-standard gateways (e.g. AgentRouter, CodeCraft).
 * Ensures zero secret leakage in logs, headers, or error descriptions.
 */

import type { ApiProviderRow } from '../db/aiRouting.ts'
import type { AdapterRequest, ProviderAdapter, ProviderCredentials, TestResult } from './types.ts'
import { ClassifiedUpstreamError, classifyHttpResponse, classifyNetworkError } from './errors.ts'

export class OpenAICompatibleAdapter implements ProviderAdapter {
  async executeChat(
    provider: ApiProviderRow,
    creds: ProviderCredentials,
    request: AdapterRequest,
  ): Promise<Response> {
    const keys = resolveApiKeys(creds)
    if (keys.length === 0) {
      throw new ClassifiedUpstreamError({
        publicStatus: 500,
        category: 'not_configured',
        crossable: true,
        publicMessage: 'This AI service route is temporarily unconfigured.',
        internalDiagnostic: `[${provider.label}] No API key configured for provider ${provider.key}`,
      })
    }

    const baseUrl = provider.base_url.replace(/\/+$/, '')
    const url = `${baseUrl}/chat/completions`
    const timeoutMs = request.timeoutMs ?? provider.timeout_ms ?? 180000

    const bodyObj: Record<string, unknown> = {
      model: request.upstreamModel,
      messages: request.messages,
      stream: true,
    }

    if (provider.key === 'agentrouter') {
      bodyObj.stream_options = { include_usage: true }
    }

    const cfg = request.configuration
    const tokenParam = cfg?.tokenParam || 'max_tokens'
    if (cfg?.maxOutputTokens && cfg.maxOutputTokens > 0) {
      bodyObj[tokenParam] = cfg.maxOutputTokens
    }
    if (cfg?.reasoningEffort && cfg?.sendReasoningEffort) {
      bodyObj.reasoning_effort = cfg.reasoningEffort
    }
    if (request.tools && request.tools.length > 0) {
      bodyObj.tools = request.tools
      bodyObj.tool_choice = 'auto'
    }

    const bodyString = JSON.stringify(bodyObj)
    const customHeaders = parseProviderHeaders(provider.headers, request.customHeaders)

    let lastError: ClassifiedUpstreamError | null = null

    for (let keyIdx = 0; keyIdx < keys.length; keyIdx++) {
      const apiKey = keys[keyIdx]
      if (request.clientSignal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }

      const controller = new AbortController()
      const onClientAbort = () => controller.abort()
      request.clientSignal.addEventListener('abort', onClientAbort, { once: true })
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...customHeaders,
      }

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: bodyString,
          signal: controller.signal,
        })

        clearTimeout(timer)
        request.clientSignal.removeEventListener('abort', onClientAbort)

        if (res.ok && res.body) {
          return res
        }

        if (res.ok && !res.body) {
          throw new ClassifiedUpstreamError({
            publicStatus: 502,
            category: 'empty_body',
            crossable: true,
            publicMessage: 'Upstream returned an empty response body.',
            internalDiagnostic: `[${provider.label}] HTTP ${res.status} with null body`,
          })
        }

        const errorBody = await readErrorBody(res)
        const classified = classifyHttpResponse(
          res.status,
          errorBody,
          'AI service',
          provider.label,
          request.upstreamModel,
          res.headers.get('retry-after'),
        )

        lastError = new ClassifiedUpstreamError(classified)

        // Try next key if this key had an authentication or rate-limiting issue
        if ((res.status === 401 || res.status === 429) && keyIdx < keys.length - 1) {
          console.warn(
            `[${provider.label}] key ${keyIdx + 1}/${keys.length} returned HTTP ${res.status}, rotating key`,
          )
          continue
        }

        throw lastError
      } catch (err) {
        clearTimeout(timer)
        request.clientSignal.removeEventListener('abort', onClientAbort)

        if (request.clientSignal.aborted) {
          throw new DOMException('Aborted', 'AbortError')
        }

        if (err instanceof ClassifiedUpstreamError) {
          lastError = err
          if (err.classification.crossable && keyIdx < keys.length - 1) {
            continue
          }
          throw err
        }

        const classified = classifyNetworkError(
          err,
          'AI service',
          provider.label,
          request.upstreamModel,
        )
        lastError = new ClassifiedUpstreamError(classified)

        if (keyIdx < keys.length - 1) {
          continue
        }

        throw lastError
      }
    }

    throw (
      lastError ??
      new ClassifiedUpstreamError({
        publicStatus: 502,
        category: 'upstream_exhausted',
        crossable: true,
        publicMessage: 'All attempts to reach the AI service failed.',
        internalDiagnostic: `[${provider.label}] exhausted all keys without success`,
      })
    )
  }

  async testConnection(
    provider: ApiProviderRow,
    creds: ProviderCredentials,
  ): Promise<TestResult> {
    const keys = resolveApiKeys(creds)
    if (keys.length === 0) {
      return { ok: false, latencyMs: 0, error: 'No API key configured for provider.' }
    }

    const baseUrl = provider.base_url.replace(/\/+$/, '')
    const url = `${baseUrl}/models`
    const apiKey = keys[0]
    const customHeaders = parseProviderHeaders(provider.headers)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const startTime = Date.now()

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          ...customHeaders,
        },
        signal: controller.signal,
      })
      const latencyMs = Date.now() - startTime
      clearTimeout(timer)

      if (res.ok) {
        return { ok: true, latencyMs, status: res.status }
      }

      // If /models returned 404/405, try a minimal 1-token chat completion as fallback probe
      if (res.status === 404 || res.status === 405) {
        return this.testRoute(provider, creds, 'gpt-4o-mini')
      }

      const errBody = await readErrorBody(res)
      return {
        ok: false,
        latencyMs,
        status: res.status,
        error: errBody.message ? errBody.message.slice(0, 200) : `HTTP ${res.status}`,
      }
    } catch (err) {
      clearTimeout(timer)
      const latencyMs = Date.now() - startTime
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, latencyMs, error: msg.slice(0, 200) }
    }
  }

  async testRoute(
    provider: ApiProviderRow,
    creds: ProviderCredentials,
    upstreamModelId: string,
  ): Promise<TestResult> {
    const keys = resolveApiKeys(creds)
    if (keys.length === 0) {
      return { ok: false, latencyMs: 0, error: 'No API key configured for provider.' }
    }

    const baseUrl = provider.base_url.replace(/\/+$/, '')
    const url = `${baseUrl}/chat/completions`
    const apiKey = keys[0]
    const customHeaders = parseProviderHeaders(provider.headers)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)
    const startTime = Date.now()

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...customHeaders,
        },
        body: JSON.stringify({
          model: upstreamModelId,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream: false,
        }),
        signal: controller.signal,
      })
      const latencyMs = Date.now() - startTime
      clearTimeout(timer)

      if (res.ok) {
        return { ok: true, latencyMs, status: res.status }
      }

      const errBody = await readErrorBody(res)
      return {
        ok: false,
        latencyMs,
        status: res.status,
        error: errBody.message ? errBody.message.slice(0, 200) : `HTTP ${res.status}`,
      }
    } catch (err) {
      clearTimeout(timer)
      const latencyMs = Date.now() - startTime
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, latencyMs, error: msg.slice(0, 200) }
    }
  }
}

function resolveApiKeys(creds: ProviderCredentials): string[] {
  const list: string[] = []
  if (creds.apiKeys && Array.isArray(creds.apiKeys)) {
    for (const k of creds.apiKeys) {
      const trimmed = k?.trim()
      if (trimmed && !list.includes(trimmed)) list.push(trimmed)
    }
  }
  if (creds.apiKey) {
    const trimmed = creds.apiKey.trim()
    if (trimmed && !list.includes(trimmed)) list.push(trimmed)
  }
  return list
}

function parseProviderHeaders(
  rawHeaders?: string | null,
  overrideHeaders?: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {}
  if (rawHeaders) {
    try {
      const parsed = JSON.parse(rawHeaders) as Record<string, string>
      if (parsed && typeof parsed === 'object') {
        Object.assign(result, parsed)
      }
    } catch {
      // Ignore malformed custom headers JSON
    }
  }
  if (overrideHeaders) {
    Object.assign(result, overrideHeaders)
  }
  return result
}

async function readErrorBody(res: Response): Promise<{ message?: string; type?: string }> {
  try {
    const text = await res.text()
    try {
      const json = JSON.parse(text) as {
        error?: { message?: string; type?: string }
        message?: string
        type?: string
      }
      return {
        message: json.error?.message ?? json.message ?? text,
        type: json.error?.type ?? json.type ?? 'upstream_error',
      }
    } catch {
      return { message: text.slice(0, 300), type: 'upstream_non_json' }
    }
  } catch {
    return { message: `HTTP ${res.status}`, type: 'read_error' }
  }
}
