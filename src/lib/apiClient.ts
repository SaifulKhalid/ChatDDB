/**
 * The one authorised `fetch`.
 *
 * Everything that talks to `/api/*` goes through here, which puts four concerns
 * in a single place instead of at every call site:
 *
 * 1. **The bearer token.** Attached from whatever `configureApiClient` was given.
 * 2. **Refresh-and-retry on 401.** Firebase ID tokens last an hour. A tab left
 *    open overnight has a stale one, and the fix is a forced refresh — not a
 *    sign-out. So a 401 triggers exactly one retry with a fresh token, and only
 *    a *second* 401 is treated as "the session is really gone".
 * 3. **Error shape.** The Worker's `{ error: { message, type } }` becomes a
 *    thrown `ApiError` carrying `status` and `type`, so callers can branch on
 *    `type` (`rate_limited`, `account_suspended`, `model_no_vision`) rather than
 *    matching on message text.
 * 4. **No ambient credentials.** `credentials: 'omit'` is explicit: auth is a
 *    header, never a cookie, which is what makes classic CSRF inapplicable to
 *    this API (see worker/lib/http.ts).
 *
 * The token provider is registered rather than imported so this module stays
 * usable outside React — `lib/api.ts` streaming and `lib/upload.ts` progress
 * both need an authorised request and neither is a component.
 */

export class ApiError extends Error {
  readonly status: number
  readonly type: string
  /** Seconds to wait, from `Retry-After` on a 429. */
  readonly retryAfter: number | undefined

  constructor(status: number, type: string, message: string, retryAfter?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.type = type
    this.retryAfter = retryAfter
  }
}

/** Thrown when a request needs a token and there is none. */
export class NotSignedInError extends ApiError {
  constructor(message = 'Sign in to continue.') {
    super(401, 'not_signed_in', message)
    this.name = 'NotSignedInError'
  }
}

type TokenProvider = (forceRefresh: boolean) => Promise<string | null>

let getTokenFn: TokenProvider = async () => null
let onSessionLost: (reason: string) => void = () => {}

/**
 * Returns a fresh bearer token for callers that cannot use `fetch` (e.g.
 * XHR upload progress via `upload.ts`).
 *
 * Set `force = true` to force-refresh the Firebase ID token before returning.
 */
export async function authToken(force = false): Promise<string> {
  const token = await getTokenFn(force)
  if (!token) throw new NotSignedInError()
  return token
}

/**
 * Wires the client to the auth provider. Called once, from `AuthProvider`.
 *
 * `onSessionLost` exists because a dead session discovered mid-request has to
 * reach the UI somehow, and the alternative — every caller checking for a 401
 * and knowing how to unmount the chat — is the bug this avoids.
 */
export function configureApiClient(options: {
  getToken: TokenProvider
  onSessionLost: (reason: string) => void
}): void {
  getTokenFn = options.getToken
  onSessionLost = options.onSessionLost
}

export interface ApiFetchOptions extends RequestInit {
  /** Set false for a route that takes no token (only `/api/health`). */
  auth?: boolean
  /** JSON body; serialised, with the content type set. Overrides `body`. */
  json?: unknown
}

/**
 * Performs an authorised request, returning the raw `Response`.
 *
 * Streaming callers want the response object, not a parsed body, so the JSON
 * convenience lives in `apiJson` on top of this rather than inside it.
 */
export async function apiFetch(path: string, options: ApiFetchOptions = {}): Promise<Response> {
  const { auth = true, json: jsonBody, ...init } = options

  const headers = new Headers(init.headers)
  let body = init.body
  if (jsonBody !== undefined) {
    body = JSON.stringify(jsonBody)
    headers.set('Content-Type', 'application/json')
  }

  const send = async (token: string | null): Promise<Response> => {
    const h = new Headers(headers)
    if (token) h.set('Authorization', `Bearer ${token}`)
    return await fetch(path, { ...init, body, headers: h, credentials: 'omit' })
  }

  let token: string | null = null
  if (auth) {
    token = await getTokenFn(false)
    if (!token) throw new NotSignedInError()
  }

  let res = await send(token)

  // One retry, and only for a token problem. `account_suspended` is a 403 and
  // `no_session` needs a fresh POST /api/auth/session, so neither is retried
  // here — a refresh would not change either answer.
  if (res.status === 401 && auth) {
    const detail = await peekError(res)
    if (detail.type === 'no_session') {
      onSessionLost(detail.type)
      throw new ApiError(401, detail.type, detail.message)
    }
    const fresh = await getTokenFn(true)
    if (fresh && fresh !== token) {
      res = await send(fresh)
    } else {
      onSessionLost(detail.type)
      throw new ApiError(401, detail.type, detail.message)
    }
    if (res.status === 401) {
      const second = await peekError(res)
      onSessionLost(second.type)
      throw new ApiError(401, second.type, second.message)
    }
  }

  if (res.status === 403) {
    const detail = await peekError(res)
    // A suspension mid-session has to end the session; the chat UI would
    // otherwise sit there failing every request with no explanation.
    if (detail.type === 'account_suspended') onSessionLost(detail.type)
    throw new ApiError(403, detail.type, detail.message)
  }

  return res
}

/** As `apiFetch`, but throws on any non-2xx and parses the JSON body. */
export async function apiJson<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const res = await apiFetch(path, options)
  if (!res.ok) throw await toApiError(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/**
 * Reads an error body without letting a parse failure mask the real problem.
 *
 * A 502 from an edge proxy is HTML, not our JSON envelope, so `type` falls back
 * to something derived from the status rather than throwing a `SyntaxError` that
 * would surface as "Unexpected token <" — an error message about the error.
 */
async function peekError(res: Response): Promise<{ type: string; message: string }> {
  let text = ''
  try {
    text = await res.text()
  } catch {
    /* body already consumed or connection dropped */
  }
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown; type?: unknown } }
    const message = parsed.error?.message
    const type = parsed.error?.type
    if (typeof message === 'string' && message.length > 0) {
      return { type: typeof type === 'string' ? type : fallbackType(res.status), message }
    }
  } catch {
    /* not our envelope */
  }
  return { type: fallbackType(res.status), message: fallbackMessage(res.status, text) }
}

export async function toApiError(res: Response): Promise<ApiError> {
  const { type, message } = await peekError(res)
  const header = res.headers.get('retry-after')
  const retryAfter = header ? Number.parseInt(header, 10) : Number.NaN
  return new ApiError(res.status, type, message, Number.isFinite(retryAfter) ? retryAfter : undefined)
}

function fallbackType(status: number): string {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'internal_error'
  return 'request_failed'
}

function fallbackMessage(status: number, body: string): string {
  if (status === 401) return 'Your session has expired. Sign in again.'
  if (status === 403) return 'You do not have access to this.'
  if (status === 429) return 'Too many requests. Try again shortly.'
  if (status >= 500) return 'Something went wrong on our side. Try again.'
  const snippet = body.trim().slice(0, 200)
  return snippet ? `Request failed (${status}): ${snippet}` : `Request failed (${status}).`
}

/** The message worth showing for any thrown value. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong.'
}

export function isRateLimit(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 429
}
