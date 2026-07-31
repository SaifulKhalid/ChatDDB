/**
 * The auth chokepoint.
 *
 * Every protected handler goes through `requireAuth` or `requireAdmin`, and the
 * router cannot reach a handler without one of them -- authorisation is not a
 * check sprinkled inside handlers that a new route could forget.
 *
 * Both functions return a *narrowed* context whose `user` and `db` are
 * non-optional. That is the enforcement mechanism: a handler that wants
 * `ctx.user` has to accept an `AuthedContext`, and the only way to get one is to
 * have gone through here.
 */

import { forbidden, unauthorized } from '../lib/http.ts'
import { requireDb } from '../db/client.ts'
import * as activity from '../db/activity.ts'
import { findByFirebaseUid, type UserRow } from '../db/users.ts'
import { bearerToken, verifyIdToken, type VerifiedToken } from './verify.ts'
import { resolvePolicy, type Policy, type WorkerEnv } from '../env.ts'
import { ipHash } from '../lib/hash.ts'

export interface RequestContext {
  request: Request
  env: WorkerEnv
  url: URL
  policy: Policy
  /** For `waitUntil` -- post-response persistence must not delay a token. */
  exec: ExecutionContext
  /** Salted hash of the client IP, or undefined when `IP_HASH_SALT` is unset. */
  ipHash: string | undefined
  userAgent: string | null
}

export interface AuthedContext extends RequestContext {
  db: D1Database
  user: UserRow
  token: VerifiedToken
}

export async function buildContext(
  request: Request,
  env: WorkerEnv,
  exec: ExecutionContext,
): Promise<RequestContext> {
  return {
    request,
    env,
    url: new URL(request.url),
    policy: resolvePolicy(env),
    exec,
    ipHash: await ipHash(request, env.IP_HASH_SALT),
    userAgent: request.headers.get('user-agent'),
  }
}

/**
 * Verifies the bearer token, then loads the user row.
 *
 * The re-read is the point. The token proves *who* the caller is; the row
 * decides what they may do. So `role` and `status` are fetched fresh on every
 * request and a suspension applies immediately, rather than waiting up to an
 * hour for Firebase's token to expire.
 */
export async function requireAuth(ctx: RequestContext): Promise<AuthedContext> {
  const raw = bearerToken(ctx.request)
  if (!raw) {
    throw unauthorized('Sign in to continue.', 'missing_token')
  }

  const db = requireDb(ctx.env.DB)
  const token = await verifyIdToken(raw, ctx.env.FIREBASE_PROJECT_ID)

  const user = await findByFirebaseUid(db, token.uid)
  if (!user) {
    // A valid token with no row means the client skipped POST /api/auth/session
    // (or the row was deleted). 401 rather than 403 so the client establishes a
    // session and retries instead of showing a dead end.
    throw unauthorized('No ChatDDB account for this sign-in. Sign in again to create one.', 'no_session')
  }

  if (user.status === 'suspended') {
    throw forbidden(
      'This account has been suspended. Contact an administrator if you believe this is a mistake.',
      'account_suspended',
    )
  }

  return { ...ctx, db, user, token }
}

/**
 * As `requireAuth`, plus an admin role check read from D1.
 *
 * The frontend's route guard is cosmetic; this is the real one. Every
 * `/api/admin/*` route passes through here, and a non-admin reaching one is
 * logged as `suspicious_activity` -- an ordinary user's client never constructs
 * those URLs, so a hit is either a probe or a bug worth seeing.
 */
export async function requireAdmin(ctx: RequestContext): Promise<AuthedContext> {
  const authed = await requireAuth(ctx)
  if (authed.user.role !== 'admin') {
    ctx.exec.waitUntil(
      activity.log(authed.db, {
        userId: authed.user.id,
        action: 'suspicious_activity',
        severity: 'warn',
        metadata: { reason: 'admin_route_denied', path: ctx.url.pathname },
        ipHash: ctx.ipHash,
        userAgent: ctx.userAgent,
      }),
    )
    throw forbidden('Administrator access is required.', 'admin_required')
  }
  return authed
}

/**
 * Resolves a user if a token is present, without requiring one.
 *
 * Only for endpoints that are useful anonymously but richer when signed in.
 * Returns `null` for *any* problem -- an invalid token here is
 * indistinguishable from no token, because nothing gated depends on the answer.
 */
export async function resolveUser(ctx: RequestContext): Promise<AuthedContext | null> {
  try {
    return await requireAuth(ctx)
  } catch {
    return null
  }
}
