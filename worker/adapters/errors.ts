/**
 * Centralized upstream error classification.
 *
 * Categorizes upstream responses into crossable (transient failures eligible for failover)
 * versus non-crossable (client/auth/validation errors that should terminate).
 *
 * Sanitizes all user-facing error messages to strictly prevent internal upstream
 * model IDs, provider names, API keys, or routing topology from leaking to the client.
 */

export interface ClassifiedError {
  /** HTTP status code suitable for public client response (e.g. 429, 400, 500, 502) */
  publicStatus: number
  /** Raw upstream HTTP status, if one was returned */
  upstreamStatus?: number
  /** Standard error category tag */
  category: string
  /** Whether the orchestrator should cross over to the next priority route */
  crossable: boolean
  /** Safe public error message that NEVER mentions upstream models or providers */
  publicMessage: string
  /** Internal diagnostic message for server logs only */
  internalDiagnostic: string
  /** Optional retry-after duration in seconds */
  retryAfterSeconds?: number
}

export class ClassifiedUpstreamError extends Error {
  readonly classification: ClassifiedError

  constructor(classification: ClassifiedError) {
    super(classification.publicMessage)
    this.name = 'ClassifiedUpstreamError'
    this.classification = classification
  }
}

const CROSSABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 524])

/**
 * Classifies an HTTP response and error body from an upstream gateway.
 */
export function classifyHttpResponse(
  status: number,
  errorBody: { message?: string; type?: string } | null,
  publicServiceName = 'AI service',
  providerLabel = 'provider',
  upstreamModelId = 'upstream-model',
  retryAfterHeader?: string | null,
): ClassifiedError {
  const rawMsg = errorBody?.message || ''
  const errorType = errorBody?.type || ''
  const retryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined
  const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter! > 0 ? retryAfter : undefined

  const internalDiagnostic = `[${providerLabel}] status=${status} model=${upstreamModelId} type=${errorType} message=${rawMsg}`

  // 1. Quota or balance exhaustion (often returned as 402 or 403 with balance keywords)
  // Crossable because a backup provider may have active balance
  if (
    status === 402 ||
    ((status === 403 || status === 401 || status === 429) &&
      /wallet|balance|plan|subscription|quota|credit|paying customers|insufficient_quota/i.test(rawMsg))
  ) {
    return {
      publicStatus: 503,
      upstreamStatus: status,
      category: 'quota_exhausted',
      crossable: true,
      publicMessage: `${publicServiceName} is temporarily unavailable due to upstream resource constraints. Please try again shortly.`,
      internalDiagnostic,
    }
  }

  // 2. Authentication failure (401)
  // Non-crossable by default unless multiple keys exist on the provider
  if (status === 401 || errorType === 'unauthorized_client_error') {
    return {
      publicStatus: 500,
      upstreamStatus: status,
      category: 'invalid_credentials',
      crossable: false,
      publicMessage: `${publicServiceName} is temporarily unavailable due to a configuration issue.`,
      internalDiagnostic,
    }
  }

  // 3. Permission forbidden (403 without balance mention)
  if (status === 403) {
    return {
      publicStatus: 500,
      upstreamStatus: status,
      category: 'forbidden',
      crossable: false,
      publicMessage: `${publicServiceName} is temporarily unavailable.`,
      internalDiagnostic,
    }
  }

  // 4. Model not found on upstream (404)
  if (status === 404) {
    return {
      publicStatus: 502,
      upstreamStatus: status,
      category: 'model_not_found',
      crossable: true, // Crossable: route model configuration is broken, try backup route
      publicMessage: `${publicServiceName} is temporarily unavailable.`,
      internalDiagnostic,
    }
  }

  // 5. Rate limited (429)
  if (status === 429) {
    const retryNotice = retryAfterSeconds ? ` Please retry after ${retryAfterSeconds}s.` : ' Please try again shortly.'
    return {
      publicStatus: 429,
      upstreamStatus: status,
      category: 'rate_limited',
      crossable: true,
      publicMessage: `${publicServiceName} is temporarily busy.${retryNotice}`,
      internalDiagnostic,
      retryAfterSeconds,
    }
  }

  // 6. Request Timeout (408)
  if (status === 408) {
    return {
      publicStatus: 504,
      upstreamStatus: status,
      category: 'timeout',
      crossable: true,
      publicMessage: `${publicServiceName} took too long to respond. Please try again.`,
      internalDiagnostic,
    }
  }

  // 7. Gateway / Server errors (500, 502, 503, 504, 522, 524)
  if (status >= 500) {
    return {
      publicStatus: 502,
      upstreamStatus: status,
      category: 'upstream_server_error',
      crossable: true,
      publicMessage: `${publicServiceName} is temporarily experiencing upstream service interruptions.`,
      internalDiagnostic,
    }
  }

  // 8. Parameter validation failure (422)
  if (status === 422) {
    return {
      publicStatus: 400,
      upstreamStatus: status,
      category: 'validation_error',
      crossable: false,
      publicMessage: `Unable to process request with ${publicServiceName}. Please adjust your prompt.`,
      internalDiagnostic,
    }
  }

  // 9. Bad request (400)
  if (status === 400) {
    // If upstream says "model ... is unavailable" or "not supported", it is crossable
    if (/model.*(?:not found|unavailable|not supported|deprecated)/i.test(rawMsg)) {
      return {
        publicStatus: 502,
        upstreamStatus: status,
        category: 'model_unavailable',
        crossable: true,
        publicMessage: `${publicServiceName} is currently unavailable.`,
        internalDiagnostic,
      }
    }
    return {
      publicStatus: 400,
      upstreamStatus: status,
      category: 'bad_request',
      crossable: false,
      publicMessage: `Invalid request for ${publicServiceName}.`,
      internalDiagnostic,
    }
  }

  // Default fallback for any other status
  const isCrossable = CROSSABLE_STATUSES.has(status)
  return {
    publicStatus: status >= 400 && status < 500 ? status : 500,
    upstreamStatus: status,
    category: 'upstream_error',
    crossable: isCrossable,
    publicMessage: `${publicServiceName} is temporarily unavailable.`,
    internalDiagnostic,
  }
}

/**
 * Classifies an unexpected network or execution error (e.g. fetch failure, AbortError, timeout).
 */
export function classifyNetworkError(
  err: unknown,
  publicServiceName = 'AI service',
  providerLabel = 'provider',
  upstreamModelId = 'upstream-model',
): ClassifiedError {
  const errMsg = err instanceof Error ? err.message : String(err)
  const isAbort = err instanceof DOMException && err.name === 'AbortError'
  const isTimeout = isAbort || /timeout|timed out|abort/i.test(errMsg)
  const internalDiagnostic = `[${providerLabel}] network error model=${upstreamModelId}: ${errMsg}`

  if (isTimeout) {
    return {
      publicStatus: 504,
      category: 'timeout',
      crossable: true,
      publicMessage: `${publicServiceName} request timed out. Please try again.`,
      internalDiagnostic,
    }
  }

  return {
    publicStatus: 502,
    category: 'network_failure',
    crossable: true,
    publicMessage: `Could not reach ${publicServiceName}. Please try again shortly.`,
    internalDiagnostic,
  }
}
