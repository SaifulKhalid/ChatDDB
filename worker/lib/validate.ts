/**
 * Shared request validation.
 *
 * House rule: **reject, do not coerce.** A malformed id or an out-of-range page
 * size is a bug or an attack, and silently repairing it hides both. The one
 * exception is pagination, where clamping is the documented, harmless
 * behaviour of every list endpoint.
 */

import { badRequest, tooLarge } from './http.ts'

/** Guardrails on the chat body, inherited from the pre-Phase-2 Worker. */
export const LIMITS = {
  maxMessages: 200,
  maxCharsPerMessage: 200_000,
  maxTotalChars: 500_000,
  maxBodyBytes: 2_000_000,
  maxTitleChars: 200,
  maxImportSessions: 200,
  maxImportMessagesPerSession: 400,
} as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) throw badRequest(`${field} must be a UUID.`)
  return value
}

/** Reads and size-checks a JSON body before parsing it. */
export async function readJsonBody(request: Request, maxBytes = LIMITS.maxBodyBytes): Promise<Record<string, unknown>> {
  const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw tooLarge('Request body is too large.')
  }
  // State-changing routes require a JSON content type. Not a CSRF defence on
  // its own (bearer auth already handles that) but it stops a form post from
  // ever reaching a handler.
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw badRequest('Content-Type must be application/json.')
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw badRequest('Body must be valid JSON.')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('Body must be a JSON object.')
  }
  return body as Record<string, unknown>
}

export function requireString(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; trim?: boolean } = {},
): string {
  if (typeof value !== 'string') throw badRequest(`${field} must be a string.`)
  const text = opts.trim === false ? value : value.trim()
  const min = opts.min ?? 1
  if (text.length < min) throw badRequest(`${field} must not be empty.`)
  if (opts.max !== undefined && text.length > opts.max) {
    throw badRequest(`${field} exceeds ${opts.max} characters.`)
  }
  return text
}

export function optionalString(
  value: unknown,
  field: string,
  opts: { max?: number } = {},
): string | undefined {
  if (value === undefined || value === null) return undefined
  return requireString(value, field, { ...opts, min: 0 })
}

export function requireEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw badRequest(`${field} must be one of: ${allowed.join(', ')}.`)
  }
  return value as T
}

export function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null) return undefined
  return requireEnum(value, field, allowed)
}

export interface Page {
  limit: number
  offset: number
}

/** Pagination is clamped rather than rejected -- the one documented exception. */
export function parsePage(url: URL, defaultLimit = 30, maxLimit = 100): Page {
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
  const offset = Number.parseInt(url.searchParams.get('offset') ?? '', 10)
  return {
    limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), maxLimit) : defaultLimit,
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  }
}

/** An inclusive millisecond range from `?from=`/`?to=`, validated not clamped. */
export function parseDateRange(url: URL): { from?: number; to?: number } {
  const read = (key: string): number | undefined => {
    const raw = url.searchParams.get(key)
    if (!raw) return undefined
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n) || n < 0) throw badRequest(`${key} must be a Unix millisecond timestamp.`)
    return n
  }
  const from = read('from')
  const to = read('to')
  if (from !== undefined && to !== undefined && from > to) {
    throw badRequest('`from` must not be after `to`.')
  }
  return { from, to }
}

/**
 * Escapes `%` and `_` so a user's search text cannot turn into a wildcard scan.
 * Pair with `LIKE ? ESCAPE '\'` -- the value still goes in as a bound
 * parameter, this only neutralises LIKE's own metacharacters.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
