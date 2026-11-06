/**
 * Auth routes.
 *
 *   POST /api/auth/session   verify an ID token, upsert the user, log the login
 *   POST /api/auth/logout    log the logout
 *   GET  /api/me             current profile, usage, and effective quota
 */

import { badRequest, forbidden, json } from '../lib/http.ts'
import { batch, requireDb, stmt } from '../db/client.ts'
import * as activity from '../db/activity.ts'
import * as users from '../db/users.ts'
import * as ratelimit from '../lib/ratelimit.ts'
import * as suspicious from '../lib/suspicious.ts'
import { bearerToken, verifyIdToken } from '../auth/verify.ts'
import type { AuthedContext, RequestContext } from '../auth/middleware.ts'
import { listVar } from '../env.ts'
import { imageReady } from '../images.ts'
import { MODELS } from '../catalog.ts'

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

  // Abuse limits on guest creation: per-minute and per-day caps per IP
  if (token.isAnonymous) {
    const existingGuest = await users.findByFirebaseUid(db, token.uid)
    if (!existingGuest) {
      const createVerdict = await ratelimit.consume(db, subject, 'guest_create', [
        { kind: 'minute', max: ctx.policy.rateGuestCreatePerMin },
        { kind: 'day', max: ctx.policy.rateGuestCreatePerDay },
      ])
      if (!createVerdict.allowed) {
        await activity.log(db, {
          action: 'rate_limited',
          severity: 'warn',
          metadata: { action: 'guest_create', limit: createVerdict.limit, count: createVerdict.count },
          ipHash: ctx.ipHash,
          userAgent: ctx.userAgent,
        })
        ratelimit.enforce(createVerdict, 'guest account creations')
      }
    }
  }

  const adminEmails = listVar(ctx.env.ADMIN_EMAILS)
  const { user, reconciledFrom } = await users.upsertOnLogin(db, token, adminEmails)

  if (reconciledFrom) {
    // The row was adopted because a *verified* email arrived under a new uid.
    // Written before anything else so the trail exists even if the response
    // never reaches the client.
    await activity.log(db, {
      userId: user.id,
      action: 'identity_reconciled',
      severity: 'warn',
      metadata: {
        previousUidSuffix: reconciledFrom.previousUid.slice(-6),
        roleCarried: user.role,
      },
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
    })
  }

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

  const action =
    user.is_guest === 1
      ? user.login_count === 1
        ? 'guest_created'
        : 'guest_login'
      : user.role === 'admin'
        ? 'admin_login'
        : 'login'

  await activity.log(db, {
    userId: user.id,
    action,
    metadata: {
      loginCount: user.login_count,
      ...(user.is_guest === 1 ? { isGuest: true } : { emailVerified: token.emailVerified }),
    },
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

/**
 * Merges a guest account into an existing registered user account.
 *
 * Called when `linkWithPopup` fails with `auth/credential-already-in-use` because
 * the Google account already exists in ChatDDB. The client signs into the existing
 * Google account and calls this route with `{ guestIdToken: string }`.
 *
 * Reassigns the guest's sessions, messages, and files (including generated images)
 * to the authenticated user in ONE D1 batch, and deletes the guest user row.
 */
export async function postMergeGuest(ctx: AuthedContext): Promise<Response> {
  const db = requireDb(ctx.env.DB)

  if (ctx.user.is_guest === 1) {
    throw badRequest('Target account cannot be a guest account.', 'target_is_guest')
  }

  let body: { guestIdToken?: unknown }
  try {
    body = (await ctx.request.json()) as { guestIdToken?: unknown }
  } catch {
    throw badRequest('Invalid JSON body.', 'invalid_json')
  }

  if (!body || typeof body.guestIdToken !== 'string' || !body.guestIdToken.trim()) {
    throw badRequest('Missing or invalid `guestIdToken`.', 'missing_guest_token')
  }

  let guestToken
  try {
    guestToken = await verifyIdToken(body.guestIdToken, ctx.env.FIREBASE_PROJECT_ID)
  } catch {
    throw badRequest('Invalid guest token.', 'invalid_guest_token')
  }

  if (!guestToken.isAnonymous) {
    throw badRequest('Guest token must be anonymous.', 'not_anonymous_token')
  }

  const guest = await users.findByFirebaseUid(db, guestToken.uid)
  if (!guest) {
    throw badRequest('Guest account not found.', 'guest_not_found')
  }

  if (guest.is_guest !== 1) {
    throw badRequest('Specified account is not a guest account.', 'not_a_guest')
  }

  if (guest.id === ctx.user.id) {
    throw badRequest('Cannot merge an account into itself.', 'self_merge')
  }

  // Reassign all sessions, messages, files and images (stored in files) in ONE D1 batch,
  // delete the guest user row (activity_logs user_id set to NULL via ON DELETE SET NULL),
  // and record the guest_merged audit log.
  await batch(db, [
    stmt('UPDATE chat_sessions SET user_id = ? WHERE user_id = ?', ctx.user.id, guest.id),
    stmt('UPDATE chat_messages SET user_id = ? WHERE user_id = ?', ctx.user.id, guest.id),
    stmt('UPDATE files SET user_id = ? WHERE user_id = ?', ctx.user.id, guest.id),
    stmt('DELETE FROM users WHERE id = ?', guest.id),
    activity.logStmt({
      userId: ctx.user.id,
      action: 'guest_merged',
      severity: 'info',
      metadata: {
        guestUserId: guest.id,
        guestFirebaseUid: guest.firebase_uid,
      },
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
    }),
  ])

  return json({ ok: true, merged: true }, 200, ctx.request, ctx.env)
}

/** The signed-in user's profile, usage totals, and remaining daily quota. */
export async function getMe(ctx: AuthedContext): Promise<Response> {
  const today = dayStart()
  const usage = await users.usageFor(ctx.db, ctx.user.id, today)
  const usedToday = await ratelimit.peek(ctx.db, `user:${ctx.user.id}`, 'chat', 'day')
  /**
   * The `'image'` counter, which is the one the composer's toggle spends. Note
   * that the model's `generate_image` tool consumes it too (see `limitImage`) --
   * it is the user's whole image budget, not only the button's. The separate,
   * stricter `'tool_image'` counter that caps the model's share of it is not
   * surfaced: it bounds a decision the user did not make, so a second number
   * next to this one would read as a second budget to ration rather than as a
   * ceiling on the assistant.
   */
  const imageUsedToday = await ratelimit.peek(ctx.db, `user:${ctx.user.id}`, 'image', 'day')

  const defaultModel = MODELS.find((m) => m.default) ?? MODELS[0]
  const publicServices = MODELS.map((m) => ({
    id: m.key,
    name: m.name,
    description: m.description,
    vision: m.capabilities.vision,
    documents: m.capabilities.documents,
    reasoning: m.capabilities.reasoning,
    tools: m.capabilities.tools,
    default: m.key === defaultModel.key,
  }))

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
        imageUsedToday,
        imageRemainingToday:
          ctx.policy.rateImagePerDay > 0
            ? Math.max(0, ctx.policy.rateImagePerDay - imageUsedToday)
            : null,
      },
      services: publicServices,
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
