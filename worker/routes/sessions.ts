/**
 * Conversation CRUD.
 *
 *   GET    /api/sessions          the sidebar list
 *   POST   /api/sessions          start an empty conversation
 *   GET    /api/sessions/:id      one transcript, with attachment metadata
 *   PATCH  /api/sessions/:id      rename
 *   DELETE /api/sessions/:id      soft delete
 *   POST   /api/sessions/import   one-time import of pre-Phase-2 localStorage
 *
 * Every handler takes an `AuthedContext` and every query is scoped by
 * `ctx.user.id` inside `db/sessions.ts`, so there is no path here that can read
 * or write another user's conversation. "Not yours" and "does not exist" both
 * return the same 404 — telling them apart would confirm which ids are real.
 */

import { badRequest, json, notFound } from '../lib/http.ts'
import { LIMITS, parsePage, readJsonBody, optionalString, requireString } from '../lib/validate.ts'
import * as sessionsDb from '../db/sessions.ts'
import * as messagesDb from '../db/messages.ts'
import * as filesDb from '../db/files.ts'
import * as activity from '../db/activity.ts'
import { toPublicFile, type PublicFile } from '../db/files.ts'
import type { AuthedContext } from '../auth/middleware.ts'

export async function listSessions(ctx: AuthedContext): Promise<Response> {
  const { limit, offset } = parsePage(ctx.url, 50, 200)
  const { rows, total } = await sessionsDb.listForUser(ctx.db, ctx.user.id, limit, offset)
  return json(
    { sessions: rows.map(sessionsDb.toPublicSession), total, limit, offset },
    200,
    ctx.request,
    ctx.env,
  )
}

/**
 * Creates an empty conversation.
 *
 * Optional — `POST /api/chat` without a `sessionId` also creates one, which is
 * the path the UI normally takes. This exists so "New chat" can produce a real
 * id before the first message when that is convenient, and so the sidebar never
 * has to hold a placeholder the server has not seen.
 *
 * A caller-supplied title is the user's own choice and is frozen as `manual`;
 * only the default 'New chat' stays eligible for auto-naming after the first
 * exchange.
 */
export async function createSession(ctx: AuthedContext): Promise<Response> {
  const body = await readJsonBody(ctx.request)
  const title = optionalString(body.title, 'title', { max: LIMITS.maxTitleChars })?.trim()
  const row = await sessionsDb.create(
    ctx.db,
    ctx.user.id,
    title || 'New chat',
    null,
    title ? 'manual' : 'placeholder',
  )

  ctx.exec.waitUntil(
    activity.log(ctx.db, {
      userId: ctx.user.id,
      action: 'chat_started',
      metadata: { sessionId: row.id, empty: true },
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
    }),
  )
  return json({ session: sessionsDb.toPublicSession(row) }, 201, ctx.request, ctx.env)
}

interface TranscriptMessage extends messagesDb.PublicMessage {
  attachments: PublicFile[]
}

/**
 * One conversation, with its messages and their attachment metadata.
 *
 * Two queries rather than a join: a join would repeat the whole message body
 * once per attachment, and message bodies are the largest thing in the database.
 */
export async function getSession(ctx: AuthedContext, id: string): Promise<Response> {
  const session = await sessionsDb.getOwned(ctx.db, id, ctx.user.id)
  if (!session) throw notFound('That conversation does not exist.', 'session_not_found')

  const [rows, files] = await Promise.all([
    messagesDb.listForSession(ctx.db, id),
    filesDb.listForSession(ctx.db, id),
  ])

  const byMessage = new Map<string, PublicFile[]>()
  for (const file of files) {
    if (!file.message_id) continue
    const list = byMessage.get(file.message_id)
    if (list) list.push(toPublicFile(file))
    else byMessage.set(file.message_id, [toPublicFile(file)])
  }

  const messages: TranscriptMessage[] = rows.map((row) => ({
    ...messagesDb.toPublicMessage(row),
    attachments: byMessage.get(row.id) ?? [],
  }))

  return json(
    { session: sessionsDb.toPublicSession(session), messages },
    200,
    ctx.request,
    ctx.env,
  )
}

export async function renameSession(ctx: AuthedContext, id: string): Promise<Response> {
  const body = await readJsonBody(ctx.request)
  const title = requireString(body.title, 'title', { max: LIMITS.maxTitleChars })

  const ok = await sessionsDb.rename(ctx.db, id, ctx.user.id, title)
  if (!ok) throw notFound('That conversation does not exist.', 'session_not_found')
  return json({ ok: true, title }, 200, ctx.request, ctx.env)
}

/**
 * Soft-deletes a conversation.
 *
 * `deleted_at` is set; the rows stay. This is disclosed in PRIVACY.md rather
 * than glossed over — a "delete" that is really a hide has to be stated, and the
 * reason it is a hide is that abuse investigation is one of the panel's jobs.
 * `npm run db:prune` is what eventually removes them.
 */
export async function deleteSession(ctx: AuthedContext, id: string): Promise<Response> {
  const ok = await sessionsDb.softDelete(ctx.db, id, ctx.user.id)
  if (!ok) throw notFound('That conversation does not exist.', 'session_not_found')
  return json({ ok: true }, 200, ctx.request, ctx.env)
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Imports the conversations a user had in `localStorage` before Phase 2.
 *
 * Runs once, from the client, on the first sign-in after the upgrade. Everything
 * about the payload is treated as untrusted: ids are regenerated server-side,
 * the owner is always the caller, and both the session count and per-session
 * message count are capped. The worst a crafted body can do is fill its own
 * author's sidebar.
 *
 * The client marks its local blob as imported rather than deleting it, because
 * chunked inserts mean a mid-way failure leaves some sessions in — keeping the
 * original is what makes that recoverable by hand.
 */
export async function importSessions(ctx: AuthedContext): Promise<Response> {
  const body = await readJsonBody(ctx.request)
  const raw = body.sessions
  if (!Array.isArray(raw)) throw badRequest('`sessions` must be an array.')
  if (raw.length === 0) return json({ imported: { sessions: 0, messages: 0 } }, 200, ctx.request, ctx.env)
  if (raw.length > LIMITS.maxImportSessions) {
    throw badRequest(
      `Too many conversations to import (${raw.length}); the limit is ${LIMITS.maxImportSessions}.`,
      'import_too_large',
    )
  }

  const incoming: sessionsDb.ImportSession[] = raw.map((entry, i) => parseImportSession(entry, i))
  const result = await sessionsDb.importSessions(ctx.db, ctx.user.id, incoming)

  ctx.exec.waitUntil(
    activity.log(ctx.db, {
      userId: ctx.user.id,
      action: 'chat_started',
      metadata: { imported: true, ...result },
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
    }),
  )
  return json({ imported: result }, 200, ctx.request, ctx.env)
}

function parseImportSession(entry: unknown, index: number): sessionsDb.ImportSession {
  if (typeof entry !== 'object' || entry === null) {
    throw badRequest(`sessions[${index}] must be an object.`)
  }
  const { title, messages, createdAt, updatedAt } = entry as Record<string, unknown>
  if (!Array.isArray(messages)) throw badRequest(`sessions[${index}].messages must be an array.`)
  if (messages.length > LIMITS.maxImportMessagesPerSession) {
    throw badRequest(
      `sessions[${index}] has too many messages (${messages.length}); the limit is ` +
        `${LIMITS.maxImportMessagesPerSession}.`,
    )
  }

  const created = timestamp(createdAt)
  const updated = timestamp(updatedAt) ?? created

  return {
    title: (optionalString(title, `sessions[${index}].title`, { max: LIMITS.maxTitleChars }) || 'Imported chat').trim(),
    createdAt: created ?? Date.now(),
    updatedAt: updated ?? Date.now(),
    messages: messages.flatMap((message, j) => {
      if (typeof message !== 'object' || message === null) {
        throw badRequest(`sessions[${index}].messages[${j}] must be an object.`)
      }
      const { role, content } = message as Record<string, unknown>
      if (role !== 'user' && role !== 'assistant') {
        throw badRequest(`sessions[${index}].messages[${j}].role must be "user" or "assistant".`)
      }
      if (typeof content !== 'string') {
        throw badRequest(`sessions[${index}].messages[${j}].content must be a string.`)
      }
      // Empty turns are dropped, not rejected: the old client could leave a
      // trailing blank assistant message behind after a Stop.
      if (content.trim().length === 0) return []
      return [
        {
          role,
          content: content.slice(0, LIMITS.maxCharsPerMessage),
          createdAt: timestamp((message as Record<string, unknown>).createdAt) ?? created ?? Date.now(),
        },
      ]
    }),
  }
}

/** Accepts a plausible epoch-millisecond value, ignoring anything else. */
function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  // A client clock can be wrong; a timestamp from the future would sort above
  // everything forever, so it is clamped to now rather than trusted.
  return Math.min(Math.floor(value), Date.now())
}
