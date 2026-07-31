/**
 * Auth routes.
 *
 *   POST /api/auth/session   verify an ID token, upsert the user, log the login
 *   POST /api/auth/logout    log the logout
 *   GET  /api/me             current profile, usage, and effective quota
 */

import { badRequest, forbidden, json } from '../lib/http.ts'
import { requireDb } from '../db/client.ts'
import * as activity from '../db/activity.ts'
import * as users from '../db/users.ts'
import * as ratelimit from '../lib/ratelimit.ts'
import * as suspicious from '../lib/suspicious.ts'
import { bearerToken, verifyIdToken } from '../auth/verify.ts'
import type { AuthedContext, RequestContext } from '../auth/middleware.ts'
import { listVar } from '../env.ts'
import { imageReady } from '../images.ts'
import { MODELS } from '../models.ts'

/** UTC midnight for a timestamp -- the boundary all daily counters share. */
export function dayStart(now = Date.now()): number {
  return Math.floor(now / 86_400_000) * 86_400_000
}

/**
 * Establishes a ChatDDB session from a Firebase ID token.
 *
 * This is the only route that verifies a token without requiring an existing
 * user row, because creating that row is its job. It is rate-limited by IP hash
 * rather than by user for the same reason -- there may not be a user yet.
 *
 * Returns the **D1 record**, not the token's claims. That distinction is the
 * whole security model: the client learns its role from a row an admin
 * controls, never from a field in a token it holds.
 */
export async function postSession(ctx: RequestContext): Promise<Response> {
  const db = requireDb(ctx.env.DB)
  const raw = bearerToken(ctx.request)
  if (!raw) throw badRequest('Send the Firebase ID token as `Authorization: Bearer <token>`.', 'missing_token')

  // Keyed on the IP hash, so a flood of forged tokens cannot make us verify
  // signatures (the expensive part) without bound.
  const subject = `ip:${ctx.ipHash ?? 'unknown'}`
  const verdict = await ratelimit.consume(db, subject, 'auth', [
    { kind: 'minute', max: ctx.policy.rateAuthPerMin },
  ])
  if (!verdict.allowed) {
    await activity.log(db, {
      action: 'rate_limited',
      severity: 'warn',
      metadata: { action: 'auth', limit: verdict.limit, count: verdict.count },
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
    })
    ratelimit.enforce(verdict, 'sign-in attempts')
  }

  let token
  try {
    token = await verifyIdToken(raw, ctx.env.FIREBASE_PROJECT_ID)
  } catch (err) {
    ctx.exec.waitUntil(
      suspicious.noteAuthFailure(db, ctx.ipHash, ctx.userAgent, 'token_verification_failed'),
    )
    throw err
  }

  const adminEmails = listVar(ctx.env.ADMIN_EMAILS)
  const user = await users.upsertOnLogin(db, token, adminEmails)

  if (user.status === 'suspended') {
    // Logged before the refusal is returned, so a suspended account's attempts
    // to get back in are visible in the feed.
    await activity.log(db, {
      userId: user.id,
      action: 'login_denied_suspended',
      severity: 'warn',
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
    })
    throw forbidden(
      'This account has been suspended. Contact an administrator if you believe this is a mistake.',
      'account_suspended',
    )
  }

  await activity.log(db, {
    userId: user.id,
    action: user.role === 'admin' ? 'admin_login' : 'login',
    metadata: { loginCount: user.login_count, emailVerified: token.emailVerified },
    ipHash: ctx.ipHash,
    userAgent: ctx.userAgent,
  })

  return json({ user: users.toPublicUser(user) }, 200, ctx.request, ctx.env)
}

/**
 * Logs a sign-out.
 *
 * There is no server-side token to invalidate -- Firebase ID tokens are
 * stateless and self-expiring, and the client discards its refresh token. This
 * route exists so the audit trail has a matching `logout` for each `login`,
 * which is what makes session duration answerable.
 */
export async function postLogout(ctx: AuthedContext): Promise<Response> {
  await activity.log(ctx.db, {
    userId: ctx.user.id,
    action: 'logout',
    ipHash: ctx.ipHash,
    userAgent: ctx.userAgent,
  })
  return json({ ok: true }, 200, ctx.request, ctx.env)
}

/** The signed-in user's profile, usage totals, and remaining daily quota. */
export async function getMe(ctx: AuthedContext): Promise<Response> {
  const today = dayStart()
  const usage = await users.usageFor(ctx.db, ctx.user.id, today)
  const usedToday = await ratelimit.peek(ctx.db, `user:${ctx.user.id}`, 'chat', 'day')

  return json(
    {
      user: users.toPublicUser(ctx.user),
      usage,
      quota: {
        chatPerDay: ctx.policy.rateChatPerDay,
        chatUsedToday: usedToday,
        chatRemainingToday:
          ctx.policy.rateChatPerDay > 0 ? Math.max(0, ctx.policy.rateChatPerDay - usedToday) : null,
        uploadPerDay: ctx.policy.rateUploadPerDay,
        maxImageBytes: ctx.policy.maxImageBytes,
        maxPdfBytes: ctx.policy.maxPdfBytes,
        maxAttachmentsPerMessage: ctx.policy.maxAttachmentsPerMessage,
        imagePerDay: ctx.policy.rateImagePerDay,
      },
      models: MODELS,
      pdfExtractMode: ctx.policy.pdfExtractMode,
      /**
       * Whether `POST /api/images` can serve. The composer hides its image
       * toggle when false, so a deployment with no `AI` binding never offers a
       * button that would only ever 503.
       */
      imageGeneration: imageReady(ctx.env),
    },
    200,
    ctx.request,
    ctx.env,
  )
}
