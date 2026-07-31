/**
 * The admin API. Every route here is behind `requireAdmin`.
 *
 *   GET   /api/admin/stats              dashboard cards, DAU, storage, action mix
 *   GET   /api/admin/users              paginated, searchable user table
 *   GET   /api/admin/users/:id          one user, with usage and recent activity
 *   PATCH /api/admin/users/:id          suspend/reactivate, promote/demote
 *   GET   /api/admin/activity           the filtered activity feed
 *   GET   /api/admin/sessions           cross-user conversation search
 *   GET   /api/admin/sessions/:id       one transcript  — writes an audit row
 *   GET   /api/admin/files              file monitoring
 *   GET   /api/admin/files/:id/url      view any file   — writes an audit row
 *
 * ## Reading private data leaves a trace
 *
 * Two of these routes let an administrator read something a user wrote for a
 * model, not for a person. Both write an `admin_chat_access` / `admin_file_access`
 * row naming the admin, the target user, and what was opened — **before** the
 * data is returned, so the trace exists even if the response never arrives. The
 * feed is not filtered by actor, so an admin's own reads are visible to the other
 * admins. This is the accountability half of the access, and PRIVACY.md says so
 * in as many words.
 *
 * ## Self-lockout guards
 *
 * `PATCH /api/admin/users/:id` refuses to suspend or demote the caller, and
 * refuses to remove the last admin. Every one of those is a request that would
 * leave the panel unreachable, needing SQL against production to undo.
 */

import { badRequest, conflict, forbidden, json, notFound } from '../lib/http.ts'
import { optionalEnum, parseDateRange, parsePage, readJsonBody, requireUuid } from '../lib/validate.ts'
import * as usersDb from '../db/users.ts'
import * as sessionsDb from '../db/sessions.ts'
import * as messagesDb from '../db/messages.ts'
import * as filesDb from '../db/files.ts'
import * as activity from '../db/activity.ts'
import * as ratelimit from '../lib/ratelimit.ts'
import { ACTIVITY_ACTIONS, type ActivityAction } from '../db/activity.ts'
import { mintViewUrl } from './files.ts'
import type { AuthedContext } from '../auth/middleware.ts'

/** Rows in the "recent activity" strip of the user drawer. */
const USER_ACTIVITY_LIMIT = 50
/** Conversations listed in the user drawer. */
const USER_SESSION_LIMIT = 20
/** How long a file has to sit unattached before it counts as an orphan. */
const ORPHAN_AGE_MS = 24 * 3_600_000

/** UTC midnight for "today" counters. Every daily figure agrees because of this. */
function dayStart(now = Date.now()): number {
  return Math.floor(now / 86_400_000) * 86_400_000
}

/**
 * Rate-limits admin reads.
 *
 * Generous (120/min by default) because the panel polls, but not absent: these
 * are the most expensive queries in the app and an admin token is the most
 * valuable one to steal, so a runaway script should hit a wall.
 */
async function limitAdmin(ctx: AuthedContext): Promise<void> {
  const verdict = await ratelimit.consume(ctx.db, `user:${ctx.user.id}`, 'admin', [
    { kind: 'minute', max: ctx.policy.rateAdminPerMin },
  ])
  ratelimit.enforce(verdict, 'admin requests')
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function getStats(ctx: AuthedContext): Promise<Response> {
  await limitAdmin(ctx)
  const today = dayStart()

  const [platform, storage, actions] = await Promise.all([
    usersDb.platformStats(ctx.db, today, 14),
    filesDb.storageStats(ctx.db, Date.now() - ORPHAN_AGE_MS),
    activity.actionCounts(ctx.db, today - 6 * 86_400_000),
  ])

  return json({ platform, storage, actions, generatedAt: Date.now() }, 200, ctx.request, ctx.env)
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const USER_SORTS = ['created_at', 'last_login', 'email', 'login_count'] as const

export async function listUsers(ctx: AuthedContext): Promise<Response> {
  await limitAdmin(ctx)
  const { limit, offset } = parsePage(ctx.url, 25, 100)
  const params = ctx.url.searchParams

  const { rows, total } = await usersDb.list(ctx.db, {
    search: params.get('search')?.trim() || undefined,
    role: optionalEnum(params.get('role') ?? undefined, 'role', ['user', 'admin'] as const),
    status: optionalEnum(params.get('status') ?? undefined, 'status', ['active', 'suspended'] as const),
    sort: optionalEnum(params.get('sort') ?? undefined, 'sort', USER_SORTS) ?? 'created_at',
    direction: params.get('direction') === 'asc' ? 'asc' : 'desc',
    limit,
    offset,
  })

  return json(
    {
      users: rows.map((row) => ({
        ...usersDb.toPublicUser(row),
        loginCount: row.login_count,
        counts: { sessions: row.session_count, messages: row.message_count, files: row.file_count },
      })),
      total,
      limit,
      offset,
    },
    200,
    ctx.request,
    ctx.env,
  )
}

/**
 * One user's detail drawer.
 *
 * Session *titles* and counts, never message bodies — opening a transcript is a
 * separate, audited request. A drawer that quietly included the last few messages
 * would make every user click a private-data read.
 */
export async function getUser(ctx: AuthedContext, id: string): Promise<Response> {
  await limitAdmin(ctx)
  const user = await usersDb.findById(ctx.db, requireUuid(id, 'user id'))
  if (!user) throw notFound('That user does not exist.', 'user_not_found')

  const [usage, recent, sessions] = await Promise.all([
    usersDb.usageFor(ctx.db, user.id, dayStart()),
    activity.recentForUser(ctx.db, user.id, USER_ACTIVITY_LIMIT),
    sessionsDb.listForUserAdmin(ctx.db, user.id, USER_SESSION_LIMIT),
  ])

  return json(
    {
      user: { ...usersDb.toPublicUser(user), loginCount: user.login_count },
      usage,
      activity: recent.map(toPublicActivity),
      sessions: sessions.map((row) => ({
        ...sessionsDb.toPublicSession(row),
        deletedAt: row.deleted_at,
      })),
    },
    200,
    ctx.request,
    ctx.env,
  )
}

/**
 * Suspends, reactivates, promotes, or demotes a user.
 *
 * Only `status` and `role` are writable. Nothing here can edit an email, a name,
 * or a `firebase_uid` — identity belongs to Firebase, and letting the panel
 * rewrite it would break the join that finds the row at all.
 */
export async function patchUser(ctx: AuthedContext, id: string): Promise<Response> {
  await limitAdmin(ctx)
  const body = await readJsonBody(ctx.request)
  const status = optionalEnum(body.status, 'status', ['active', 'suspended'] as const)
  const role = optionalEnum(body.role, 'role', ['user', 'admin'] as const)
  if (status === undefined && role === undefined) {
    throw badRequest('Provide `status`, `role`, or both.')
  }

  const target = await usersDb.findById(ctx.db, requireUuid(id, 'user id'))
  if (!target) throw notFound('That user does not exist.', 'user_not_found')

  const isSelf = target.id === ctx.user.id
  if (isSelf && status === 'suspended') {
    throw forbidden('You cannot suspend your own account.', 'self_suspend')
  }
  if (isSelf && role === 'user') {
    // A demotion is not undoable from inside the panel: the moment it lands the
    // caller loses the route that would reverse it.
    throw forbidden('You cannot remove your own administrator access.', 'self_demote')
  }

  // Guard the *last* admin as well as the caller. Two admins where one demotes
  // the other is fine; the second one going is a locked panel.
  const losesAdmin = target.role === 'admin' && (role === 'user' || status === 'suspended')
  if (losesAdmin && (await usersDb.countAdmins(ctx.db)) <= 1) {
    throw conflict(
      'This is the only administrator account. Promote another administrator first.',
      'last_admin',
    )
  }

  const changes: Record<string, unknown> = {}
  if (status !== undefined && status !== target.status) {
    await usersDb.setStatus(ctx.db, target.id, status)
    changes.status = status
  }
  if (role !== undefined && role !== target.role) {
    await usersDb.setRole(ctx.db, target.id, role)
    changes.role = role
  }

  if (Object.keys(changes).length === 0) {
    // Idempotent, and reported as such: "no change" is a different fact from
    // "changed", and an admin re-clicking Suspend should not see a fresh log row.
    return json({ user: usersDb.toPublicUser(target), changed: false }, 200, ctx.request, ctx.env)
  }

  // Awaited, not `waitUntil`ed: this row is the record of a privileged mutation,
  // and it must be durable before the response says the change happened.
  await activity.log(ctx.db, {
    userId: ctx.user.id,
    action: 'admin_user_updated',
    severity: 'warn',
    metadata: { targetUserId: target.id, from: { role: target.role, status: target.status }, to: changes },
    ipHash: ctx.ipHash,
    userAgent: ctx.userAgent,
  })

  const updated = await usersDb.findById(ctx.db, target.id)
  return json(
    { user: usersDb.toPublicUser(updated ?? target), changed: true, changes },
    200,
    ctx.request,
    ctx.env,
  )
}

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

export async function getActivity(ctx: AuthedContext): Promise<Response> {
  await limitAdmin(ctx)
  const { limit, offset } = parsePage(ctx.url, 50, 200)
  const { from, to } = parseDateRange(ctx.url)
  const params = ctx.url.searchParams

  const userId = params.get('userId')?.trim()
  const { rows, total } = await activity.query(ctx.db, {
    userId: userId ? requireUuid(userId, 'userId') : undefined,
    action: optionalEnum<ActivityAction>(params.get('action') ?? undefined, 'action', ACTIVITY_ACTIONS),
    severity: optionalEnum(params.get('severity') ?? undefined, 'severity', ['info', 'warn', 'alert'] as const),
    from,
    to,
    limit,
    offset,
  })

  return json(
    {
      activity: rows.map((row) => ({
        ...toPublicActivity(row),
        user: row.user_id ? { id: row.user_id, email: row.email, name: row.name } : null,
      })),
      total,
      limit,
      offset,
      actions: ACTIVITY_ACTIONS,
    },
    200,
    ctx.request,
    ctx.env,
  )
}

interface PublicActivity {
  id: string
  action: string
  severity: string
  timestamp: number
  metadata: unknown
  ipHash: string | null
  userAgent: string | null
}

/**
 * Shapes a log row for the feed.
 *
 * `metadata` is parsed here rather than in the browser so a row written by an
 * older build with unparseable JSON degrades to the raw string in one place. Note
 * `ipHash` is the truncated salted hash, never an address — there is no route in
 * this file that could return an IP, because none is stored.
 */
function toPublicActivity(row: activity.ActivityRow): PublicActivity {
  let metadata: unknown = null
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata)
    } catch {
      metadata = row.metadata
    }
  }
  return {
    id: row.id,
    action: row.action,
    severity: row.severity,
    timestamp: row.timestamp,
    metadata,
    ipHash: row.ip_hash,
    userAgent: row.user_agent,
  }
}

// ---------------------------------------------------------------------------
// Chat inspector
// ---------------------------------------------------------------------------

/**
 * Cross-user conversation search.
 *
 * Titles and metadata only — no message bodies, so browsing the list is not
 * itself a private-data read and needs no audit row. `?includeDeleted=1` surfaces
 * soft-deleted conversations, which is the reason they are soft-deleted.
 */
export async function listAdminSessions(ctx: AuthedContext): Promise<Response> {
  await limitAdmin(ctx)
  const { limit, offset } = parsePage(ctx.url, 25, 100)
  const params = ctx.url.searchParams
  const userId = params.get('userId')?.trim()

  const { rows, total } = await sessionsDb.adminSearch(ctx.db, {
    search: params.get('search')?.trim() || undefined,
    userId: userId ? requireUuid(userId, 'userId') : undefined,
    includeDeleted: params.get('includeDeleted') === '1',
    limit,
    offset,
  })

  return json(
    {
      sessions: rows.map((row) => ({
        ...sessionsDb.toPublicSession(row),
        deletedAt: row.deleted_at,
        user: { id: row.user_id, email: row.email, name: row.name },
      })),
      total,
      limit,
      offset,
    },
    200,
    ctx.request,
    ctx.env,
  )
}

/**
 * One transcript, including soft-deleted ones.
 *
 * The audit row is written and awaited **before** the messages are read. The
 * ordering is the whole point: if this handler crashed, or the admin closed the
 * tab mid-response, the record of the access would still exist.
 */
export async function getAdminSession(ctx: AuthedContext, id: string): Promise<Response> {
  await limitAdmin(ctx)
  const session = await sessionsDb.getAny(ctx.db, requireUuid(id, 'session id'))
  if (!session) throw notFound('That conversation does not exist.', 'session_not_found')

  await activity.log(ctx.db, {
    userId: ctx.user.id,
    action: 'admin_chat_access',
    severity: 'warn',
    metadata: {
      sessionId: session.id,
      targetUserId: session.user_id,
      messageCount: session.message_count,
      deleted: session.deleted_at !== null,
    },
    ipHash: ctx.ipHash,
    userAgent: ctx.userAgent,
  })

  const [owner, rows, files] = await Promise.all([
    usersDb.findById(ctx.db, session.user_id),
    messagesDb.listForSession(ctx.db, session.id),
    filesDb.listForSession(ctx.db, session.id),
  ])

  const byMessage = new Map<string, filesDb.PublicFile[]>()
  for (const file of files) {
    if (!file.message_id) continue
    const list = byMessage.get(file.message_id)
    if (list) list.push(filesDb.toPublicFile(file))
    else byMessage.set(file.message_id, [filesDb.toPublicFile(file)])
  }

  return json(
    {
      session: { ...sessionsDb.toPublicSession(session), deletedAt: session.deleted_at },
      user: owner ? usersDb.toPublicUser(owner) : null,
      messages: rows.map((row) => ({
        ...messagesDb.toPublicMessage(row),
        // The admin view is the one place token accounting is shown, with its
        // source, so an estimate is never read as a billing figure.
        tokens: {
          prompt: row.prompt_tokens,
          completion: row.completion_tokens,
          total: row.total_tokens,
          source: row.token_source,
        },
        attachments: byMessage.get(row.id) ?? [],
      })),
      audited: true,
    },
    200,
    ctx.request,
    ctx.env,
  )
}

// ---------------------------------------------------------------------------
// File monitoring
// ---------------------------------------------------------------------------

export async function listAdminFiles(ctx: AuthedContext): Promise<Response> {
  await limitAdmin(ctx)
  const { limit, offset } = parsePage(ctx.url, 25, 100)
  const params = ctx.url.searchParams
  const userId = params.get('userId')?.trim()

  const { rows, total } = await filesDb.adminList(ctx.db, {
    search: params.get('search')?.trim() || undefined,
    userId: userId ? requireUuid(userId, 'userId') : undefined,
    type: optionalEnum(params.get('type') ?? undefined, 'type', ['image', 'pdf'] as const),
    processing: optionalEnum(params.get('processing') ?? undefined, 'processing', [
      'none',
      'pending',
      'done',
      'failed',
      'unsupported',
    ] as const),
    limit,
    offset,
  })

  return json(
    {
      files: rows.map((row) => ({
        ...filesDb.toPublicFile(row),
        sessionId: row.session_id,
        messageId: row.message_id,
        sha256: row.sha256,
        user: { id: row.user_id, email: row.email, name: row.name },
      })),
      total,
      limit,
      offset,
    },
    200,
    ctx.request,
    ctx.env,
  )
}

/**
 * A signed view URL for any user's file.
 *
 * Same signing path and same five-minute TTL as the owner's own URL — an admin
 * gets no longer-lived capability than the user does. Audited before the URL is
 * minted, because the URL *is* the access.
 */
export async function getAdminFileUrl(ctx: AuthedContext, id: string): Promise<Response> {
  await limitAdmin(ctx)
  const row = await filesDb.getAny(ctx.db, requireUuid(id, 'file id'))
  if (!row) throw notFound('That file does not exist.', 'file_not_found')

  await activity.log(ctx.db, {
    userId: ctx.user.id,
    action: 'admin_file_access',
    severity: 'warn',
    metadata: { fileId: row.id, targetUserId: row.user_id, type: row.file_type, bytes: row.file_size },
    ipHash: ctx.ipHash,
    userAgent: ctx.userAgent,
  })

  const signed = await mintViewUrl(ctx.env, ctx.url.origin, row)
  return json({ ...signed, audited: true }, 200, ctx.request, ctx.env)
}

/**
 * Extracted-text preview for a PDF, for triaging a failed extraction.
 *
 * Reads the D1 preview column, not the R2 side-car: 2,000 characters is enough
 * to see whether extraction produced sense, and it keeps this off the path that
 * would hand over a whole document.
 */
export async function getAdminFileText(ctx: AuthedContext, id: string): Promise<Response> {
  await limitAdmin(ctx)
  const row = await filesDb.getAny(ctx.db, requireUuid(id, 'file id'))
  if (!row) throw notFound('That file does not exist.', 'file_not_found')

  await activity.log(ctx.db, {
    userId: ctx.user.id,
    action: 'admin_file_access',
    severity: 'warn',
    metadata: { fileId: row.id, targetUserId: row.user_id, preview: true },
    ipHash: ctx.ipHash,
    userAgent: ctx.userAgent,
  })

  return json(
    {
      preview: row.extracted_text_preview,
      chars: row.extracted_chars,
      pages: row.extracted_pages,
      source: row.extraction_source,
      status: row.processing_status,
      truncated: (row.extracted_chars ?? 0) > (row.extracted_text_preview?.length ?? 0),
      audited: true,
    },
    200,
    ctx.request,
    ctx.env,
  )
}
