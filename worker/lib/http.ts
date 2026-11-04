/**
 * HTTP plumbing: JSON responses, the error vocabulary, and CORS.
 *
 * Extracted from `index.ts` so every route module shares one error shape --
 * `{ error: { message, type } }` -- which is what `src/lib/api.ts` and
 * `src/lib/apiClient.ts` both parse.
 *
 * ## Status codes are load-bearing
 *
 * Every status here reaches the client as a real error. `src/lib/api.ts` used to
 * treat 404, 502 and 503 as "no backend yet" and quietly stream a local mock
 * reply, which turned an auth failure returned as 503 into something that looked
 * like a working demo. That fallback is gone (login is required, so a faked
 * answer was worse than an honest error), and with it the constraint that made
 * only three codes safe to return. The vocabulary below is now chosen for what
 * it tells the *client*: 401/403 for identity, 404 for a missing resource, 429
 * with `Retry-After` for limits, 502/503 for an upstream that failed or was
 * never configured.
 */

import { listVar, type WorkerEnv } from '../env.ts'

export class ApiError extends Error {
  readonly status: number
  readonly type: string
  /** Extra fields merged into the error body, e.g. `retryAfter`. */
  readonly detail: Record<string, unknown> | undefined

  constructor(status: number, type: string, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.type = type
    this.detail = detail
  }
}

export const badRequest = (message: string, type = 'invalid_request') =>
  new ApiError(400, type, message)

export const unauthorized = (message = 'Sign in to continue.', type = 'unauthorized') =>
  new ApiError(401, type, message)

export const forbidden = (message = 'You do not have access to this resource.', type = 'forbidden') =>
  new ApiError(403, type, message)

/**
 * 404 for a *resource*. Used on JSON routes where the client asked for
 * something by id and it is not there; it is never how the chat stream reports
 * its own failure to start.
 */
export const notFound = (message = 'Not found.', type = 'not_found') =>
  new ApiError(404, type, message)

export const conflict = (message: string, type = 'conflict') => new ApiError(409, type, message)

export const tooLarge = (message: string, type = 'payload_too_large') =>
  new ApiError(413, type, message)

export const rateLimited = (message: string, retryAfterSeconds: number) =>
  new ApiError(429, 'rate_limited', message, { retryAfter: retryAfterSeconds })

export const serverError = (message = 'Something went wrong on our side.', type = 'internal_error') =>
  new ApiError(500, type, message)

/** The service cannot run at all (no key, no binding). */
export const notConfigured = (message: string) => new ApiError(503, 'not_configured', message)

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/**
 * Origins allowed without configuration: the local Vite dev server and the
 * local Worker. Production is same-origin (the Worker serves the SPA), so it
 * needs no entry -- add one to `ALLOWED_ORIGINS` only for a split deployment.
 */
const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
]

export function allowedOrigins(env: WorkerEnv): string[] {
  const configured = listVar(env.ALLOWED_ORIGINS)
  return configured.length > 0 ? [...configured, ...DEV_ORIGINS] : DEV_ORIGINS
}

/**
 * CORS headers for a request.
 *
 * The old behaviour echoed any `Origin` back. With auth present that is too
 * loose, so this is an allowlist. Note there is deliberately no
 * `Access-Control-Allow-Credentials`: auth is a bearer header, never a cookie,
 * so there are no ambient credentials for a cross-site request to ride on --
 * which is also why classic CSRF does not apply to this API.
 */
export function corsHeaders(request: Request, env: WorkerEnv): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    // The chat stream reports the ids it created in headers rather than in a
    // frame, so a cross-origin dev client has to be allowed to read them. Every
    // header listed here is one `routes/chat.ts` actually sets — the expose list
    // and the sender have to stay in step, or the browser silently drops the
    // value the client is waiting for.
    'Access-Control-Expose-Headers':
      'X-ChatDDB-Model, X-ChatDDB-Session-Id, X-ChatDDB-Message-Id, X-ChatDDB-Generated-File, X-ChatDDB-Generated-File-JSON, Retry-After',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
  const origin = request.headers.get('origin')
  // No Origin header means a same-origin or non-browser request; nothing to add.
  if (!origin) return headers
  if (allowedOrigins(env).includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  // A disallowed origin gets no ACAO header at all, so the browser blocks the
  // read. Returning the response (rather than a 403) keeps curl and same-origin
  // tooling working unchanged.
  return headers
}

export function preflight(request: Request, env: WorkerEnv): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) })
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export function json(
  payload: unknown,
  status = 200,
  request?: Request,
  env?: WorkerEnv,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(request && env ? corsHeaders(request, env) : {}),
      ...extraHeaders,
    },
  })
}

/** Renders any thrown value as the standard error body. */
export function errorResponse(err: unknown, request: Request, env: WorkerEnv): Response {
  if (err instanceof ApiError) {
    const extra: Record<string, string> = {}
    const retryAfter = err.detail?.retryAfter
    if (typeof retryAfter === 'number') extra['Retry-After'] = String(Math.ceil(retryAfter))
    return json(
      { error: { message: err.message, type: err.type, ...err.detail } },
      err.status,
      request,
      env,
      extra,
    )
  }
  if (isAbort(err)) return new Response(null, { status: 499 })

  console.error('[chatddb] unhandled', err)
  return json(
    { error: { message: 'Something went wrong on our side.', type: 'internal_error' } },
    500,
    request,
    env,
  )
}

export function methodNotAllowed(request: Request, env: WorkerEnv, allow: string): Response {
  return json(
    { error: { message: `Use ${allow} for this endpoint.`, type: 'method_not_allowed' } },
    405,
    request,
    env,
    { Allow: allow },
  )
}

export function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}
