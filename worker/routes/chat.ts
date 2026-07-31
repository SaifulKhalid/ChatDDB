/**
 * `POST /api/chat` — the one route that spends money, so the one with the most
 * checks in front of it.
 *
 * ## The breaking change
 *
 * The body used to be `{messages: [...]}`: the client sent the whole
 * conversation and the Worker forwarded it. Now it is
 *
 *   {sessionId?, content, attachments?, model?, replaceFromMessageId?, regenerate?}
 *
 * and the conversation is rebuilt from D1. A client can no longer forge an
 * assistant turn, put words in the model's mouth, or splice in text from someone
 * else's chat, because the only thing it contributes is the current user turn.
 * This is the single largest security gain of Phase 2 and the reason the shape
 * changed rather than being extended.
 *
 * ## What runs before the request, and what runs after
 *
 * Before the stream opens: auth, rate limits, session ownership, attachment
 * ownership, and model capability. All of these are cheap and all of them can
 * refuse. After the last frame is written: the assistant row, the counters, and
 * the heuristics — via `ctx.waitUntil`, so no database write ever sits between
 * the user and their first token.
 *
 * The three modes share this path deliberately:
 *   - send        `content`
 *   - edit        `content` + `replaceFromMessageId` (truncates, then sends)
 *   - regenerate  `regenerate: true` (drops the last answer, re-sends the turn)
 */

import {
  listModels,
  NotConfiguredError,
  resolveConfig,
  UpstreamError,
  type ChatMessage,
  type ContentPart,
  type UpstreamConfig,
} from '../agentrouter.ts'
import {
  completeWithFailover,
  resolveFallback,
  resolveProviders,
  titleWithFailover,
  type UpstreamAttempt,
} from '../failover.ts'
import { toClientStream, type StreamResult } from '../sse.ts'
import { badRequest, corsHeaders, json, notConfigured, notFound } from '../lib/http.ts'
import { LIMITS, readJsonBody, optionalString, requireString, requireUuid, isUuid } from '../lib/validate.ts'
import { batch, requireBucket } from '../db/client.ts'
import * as activity from '../db/activity.ts'
import * as messagesDb from '../db/messages.ts'
import * as sessionsDb from '../db/sessions.ts'
import * as filesDb from '../db/files.ts'
import * as ratelimit from '../lib/ratelimit.ts'
import * as suspicious from '../lib/suspicious.ts'
import { buildDocumentContext, imageDataUrl } from '../lib/files/context.ts'
import { resolveModel, isKnownModel, NO_VISION_MESSAGE, MODELS, type ModelSpec } from '../models.ts'
import { sha256Hex } from '../lib/hash.ts'
import type { AuthedContext } from '../auth/middleware.ts'
import type { FileRow } from '../db/files.ts'

const DEFAULT_SYSTEM_PROMPT = [
  'You are ChatDDB, a helpful, knowledgeable AI assistant.',
  'Answer accurately and get to the point; expand only when the question needs it.',
  'Use Markdown — fenced code blocks with a language tag, tables where they help.',
  'If you are unsure or lack the information, say so rather than guessing.',
].join(' ')

interface ChatBody {
  sessionId?: string
  content?: string
  attachments: string[]
  model?: string
  replaceFromMessageId?: string
  regenerate: boolean
}

function parseBody(raw: Record<string, unknown>): ChatBody {
  // A leftover `messages` array is the pre-Phase-2 client. Say so explicitly:
  // "content must be a string" would send someone hunting in the wrong place.
  if (Array.isArray(raw.messages)) {
    throw badRequest(
      'This endpoint no longer accepts a `messages` array — conversation history is stored server-side. ' +
        'Send `{sessionId, content}` instead, and hard-reload to pick up the current frontend.',
      'legacy_client',
    )
  }

  const regenerate = raw.regenerate === true
  const content = regenerate
    ? optionalString(raw.content, 'content', { max: LIMITS.maxCharsPerMessage })
    : requireString(raw.content, 'content', { max: LIMITS.maxCharsPerMessage })

  let attachments: string[] = []
  if (raw.attachments !== undefined && raw.attachments !== null) {
    if (!Array.isArray(raw.attachments)) throw badRequest('`attachments` must be an array of file ids.')
    attachments = raw.attachments.map((id, i) => {
      if (!isUuid(id)) throw badRequest(`attachments[${i}] must be a file id.`)
      return id
    })
    // De-duplicate: the same image twice is billed twice and helps nobody.
    attachments = [...new Set(attachments)]
  }

  return {
    sessionId:
      raw.sessionId === undefined || raw.sessionId === null
        ? undefined
        : requireUuid(raw.sessionId, 'sessionId'),
    content,
    attachments,
    model: optionalString(raw.model, 'model', { max: 100 }),
    replaceFromMessageId:
      raw.replaceFromMessageId === undefined || raw.replaceFromMessageId === null
        ? undefined
        : requireUuid(raw.replaceFromMessageId, 'replaceFromMessageId'),
    regenerate,
  }
}

export async function postChat(ctx: AuthedContext): Promise<Response> {
  let providers: UpstreamConfig[]
  try {
    providers = resolveProviders(ctx.env)
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      // 503 on purpose: the frontend reads it as "backend not wired up" and
      // streams its local mock reply, which keeps an unconfigured deployment
      // demoable. The real reason is in the body and the logs.
      console.warn('[chatddb] %s', err.message)
      throw notConfigured(err.message)
    }
    throw err
  }

  const body = parseBody(await readJsonBody(ctx.request))
  const model = pickModel(body.model, providers[0].model)

  await limitChat(ctx)

  const session = await resolveSession(ctx, body, model.id)
  const turn = await prepareTurn(ctx, body, session.id, model)

  const upstream = buildUpstreamMessages(ctx, turn)

  // The requested registry id applies to the primary only. The backup serves a
  // different catalogue and keeps the model its own config named — see the
  // "registry says requested, DB says served" note in PHASE2-2.md §5.
  const chain = providers.map((cfg, i) => (i === 0 ? { ...cfg, model: model.id } : cfg))

  // Which gateway owns a failure below. Advanced on each crossover so
  // `persistFailure` blames the one that actually refused last.
  let failed = chain[0]

  let attempt: UpstreamAttempt
  try {
    attempt = await completeWithFailover(chain, upstream, ctx.request.signal, (from, to, err) => {
      failed = chain.find((cfg) => cfg.provider === to) ?? failed
      ctx.exec.waitUntil(
        activity.log(ctx.db, {
          userId: ctx.user.id,
          action: 'upstream_failover',
          severity: 'warn',
          metadata: {
            from,
            to,
            reason: err.type,
            upstreamStatus: err.upstreamStatus ?? null,
            sessionId: session.id,
          },
        }),
      )
    })
  } catch (err) {
    // Nothing streamed, so the user turn we just wrote has no answer. Record the
    // failure against the session rather than leaving a silent gap.
    if (err instanceof UpstreamError) {
      ctx.exec.waitUntil(persistFailure(ctx, session.id, model, failed, err.message))
      console.error(
        '[chatddb] upstream %s %s (%s): %s',
        failed.provider, err.upstreamStatus ?? '-', err.type, err.message,
      )
    }
    throw err
  }

  const stream = toClientStream(attempt.res, (result) => {
    ctx.exec.waitUntil(persistAssistant(ctx, session, chain, attempt, model, turn, result))
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Stops intermediate proxies buffering the stream into one blob.
      'X-Accel-Buffering': 'no',
      // Still the model that was *asked for*, even on a crossover: the frontend
      // must not be able to tell, and it keys its own state off this.
      'X-ChatDDB-Model': model.id,
      // Present only when the backup answered, and deliberately *not* added to
      // `Access-Control-Expose-Headers` in `lib/http.ts`: a cross-origin
      // browser client cannot read it, so the UI cannot start depending on it.
      // Under curl it is the fastest way to confirm failover fired.
      ...(attempt.crossedOver
        ? { 'X-ChatDDB-Upstream': attempt.provider, 'X-ChatDDB-Upstream-Model': attempt.model }
        : {}),
      // How a client that sent no `sessionId` learns which chat it just started,
      // without waiting for the stream to finish.
      'X-ChatDDB-Session-Id': session.id,
      ...(turn.userMessageId ? { 'X-ChatDDB-Message-Id': turn.userMessageId } : {}),
      ...corsHeaders(ctx.request, ctx.env),
    },
  })
}

/** `GET /api/models` — the registry, not AgentRouter's raw list. */
export function getModels(ctx: AuthedContext): Response {
  return json(
    { models: MODELS, default: resolveModel(undefined, ctx.env.AGENTROUTER_MODEL ?? '').id },
    200,
    ctx.request,
    ctx.env,
  )
}

/**
 * `GET /api/admin/models` — a gateway's raw model list, verbatim.
 *
 * A debugging tool, behind the admin guard, and separate from `/api/models` on
 * purpose: this is *their* catalogue, which is much longer than what ChatDDB
 * supports and says nothing about whether a given model works here. Answering an
 * ordinary user with it would invite picking one that the registry has no entry
 * for, and `pickModel` would then reject it.
 *
 * AgentRouter by default; `?provider=freemodel` asks the backup instead. This
 * route deliberately does *not* fail over — the question it answers is "what did
 * this specific gateway say", and silently answering about a different one would
 * make it useless for diagnosing the gateway that is broken.
 */
export async function getUpstreamModels(ctx: AuthedContext): Promise<Response> {
  const wanted = new URL(ctx.request.url).searchParams.get('provider')?.trim()
  let config
  try {
    if (wanted === 'freemodel') {
      const fallback = resolveFallback(ctx.env)
      if (!fallback) {
        throw notConfigured(
          'No fallback gateway is configured. Set FREEMODEL_API_KEY (npm run secret:freemodel) ' +
            'and leave FALLBACK_ENABLED unset or "true".',
        )
      }
      config = fallback
    } else {
      config = resolveConfig(ctx.env)
    }
  } catch (err) {
    if (err instanceof NotConfiguredError) throw notConfigured(err.message)
    throw err
  }
  const res = await listModels(config, ctx.request.signal)
  const text = await res.text()
  // Passed through as bytes rather than re-serialised: the point of this route is
  // to see exactly what the provider said, including a shape we did not expect.
  return new Response(text, {
    status: res.ok ? 200 : 502,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(ctx.request, ctx.env),
    },
  })
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function pickModel(requested: string | undefined, configured: string): ModelSpec {
  if (requested && !isKnownModel(requested)) {
    throw badRequest(
      `Unknown model \`${requested}\`. Available: ${MODELS.map((m) => m.id).join(', ')}.`,
      'unknown_model',
    )
  }
  return resolveModel(requested, configured)
}

/**
 * Consumes the per-user chat budget.
 *
 * Keyed on the user id, not the IP: a household behind one address should not
 * share a quota, and one user on a phone plus a laptop is still one user.
 */
async function limitChat(ctx: AuthedContext): Promise<void> {
  const verdict = await ratelimit.consume(ctx.db, `user:${ctx.user.id}`, 'chat', [
    { kind: 'minute', max: ctx.policy.rateChatPerMin },
    { kind: 'day', max: ctx.policy.rateChatPerDay },
  ])
  if (verdict.allowed) return

  await activity.log(ctx.db, {
    userId: ctx.user.id,
    action: 'rate_limited',
    severity: 'warn',
    metadata: { action: 'chat', window: verdict.kind, limit: verdict.limit, count: verdict.count },
    ipHash: ctx.ipHash,
    userAgent: ctx.userAgent,
  })
  ctx.exec.waitUntil(
    suspicious.afterRateLimit(
      { db: ctx.db, userId: ctx.user.id, ipHash: ctx.ipHash, userAgent: ctx.userAgent },
      'chat',
    ),
  )
  ratelimit.enforce(verdict, 'messages')
}

/** Finds the caller's session, or starts one titled from this first message. */
async function resolveSession(
  ctx: AuthedContext,
  body: ChatBody,
  modelId: string,
): Promise<sessionsDb.SessionRow> {
  if (body.sessionId) {
    const existing = await sessionsDb.getOwned(ctx.db, body.sessionId, ctx.user.id)
    // Ownership failure and "no such id" are the same 404 on purpose: a
    // different answer for each would confirm that another user's id exists.
    if (!existing) throw notFound('That conversation does not exist.', 'session_not_found')
    return existing
  }

  if (body.regenerate) throw badRequest('`regenerate` needs a `sessionId`.', 'missing_session')

  const created = await sessionsDb.create(
    ctx.db,
    ctx.user.id,
    sessionsDb.makeTitle(body.content ?? ''),
    modelId,
  )
  ctx.exec.waitUntil(
    activity.log(ctx.db, {
      userId: ctx.user.id,
      action: 'chat_started',
      metadata: { sessionId: created.id, model: modelId },
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
    }),
  )
  return created
}

/** Everything the upstream call needs, assembled and already persisted. */
interface Turn {
  history: { role: messagesDb.MessageRole; content: string }[]
  /** The current user turn's text, document context already prepended. */
  text: string
  /**
   * The user's own words, without the document context block.
   *
   * Kept apart from `text` for the titler: `clip()` takes the first 800
   * characters, so titling from `text` would name the session after the opening
   * of an attached PDF rather than the question asked about it.
   */
  userText: string
  images: ContentPart[]
  /** Null on regenerate — no new user row is written. */
  userMessageId: string | null
  /** For the estimate when upstream reports no usage. */
  promptChars: number
  promptHash: string
  attachmentCount: number
}

async function prepareTurn(
  ctx: AuthedContext,
  body: ChatBody,
  sessionId: string,
  model: ModelSpec,
): Promise<Turn> {
  if (body.regenerate) return prepareRegenerate(ctx, sessionId, model)

  const content = body.content as string
  const files = await loadAttachments(ctx, body.attachments, model)

  if (body.replaceFromMessageId) {
    await truncateFrom(ctx, sessionId, body.replaceFromMessageId)
  }

  // Read before the insert, so the history is everything *except* this turn.
  const history = await messagesDb.historyFor(
    ctx.db,
    sessionId,
    ctx.policy.historyMaxTurns,
    LIMITS.maxTotalChars,
  )

  const now = Date.now()
  const inserted = messagesDb.insertStmt({
    sessionId,
    userId: ctx.user.id,
    role: 'user',
    content,
    model: model.id,
    modelProvider: model.provider,
    attachmentCount: files.length,
    createdAt: now,
  })

  const promptHash = (await sha256Hex(content)).slice(0, 16)
  const statements = [
    inserted.stmt,
    sessionsDb.touchStmt(sessionId, 1, model.id, now),
    activity.logStmt({
      userId: ctx.user.id,
      action: 'message_sent',
      metadata: {
        sessionId,
        model: model.id,
        chars: content.length,
        attachments: files.length,
        promptHash,
      },
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
    }),
  ]
  if (files.length > 0) {
    statements.push(
      filesDb.attachToMessageStmt(files.map((f) => f.id), inserted.id, sessionId, ctx.user.id),
    )
  }
  // One transaction: the message, the counters, the audit row, and the file
  // links all land together or not at all.
  await batch(ctx.db, statements)

  ctx.exec.waitUntil(
    suspicious.afterMessage(
      { db: ctx.db, userId: ctx.user.id, ipHash: ctx.ipHash, userAgent: ctx.userAgent },
      promptHash,
    ),
  )

  const text = await withDocuments(ctx, files, content)
  return {
    history,
    text,
    userText: content,
    images: await imageParts(ctx, files),
    userMessageId: inserted.id,
    promptChars: history.reduce((n, m) => n + m.content.length, 0) + text.length,
    promptHash,
    attachmentCount: files.length,
  }
}

/**
 * Re-answers the last user turn.
 *
 * The previous answer is deleted rather than kept as an alternative: the UI has
 * no branch picker, and a hidden branch nobody can reach is just rows nobody
 * asked to store.
 */
async function prepareRegenerate(
  ctx: AuthedContext,
  sessionId: string,
  model: ModelSpec,
): Promise<Turn> {
  const last = await messagesDb.lastForSession(ctx.db, sessionId)
  if (!last) throw badRequest('This conversation has no messages to regenerate.', 'nothing_to_regenerate')

  if (last.role === 'assistant') {
    await batch(ctx.db, [
      messagesDb.truncateFromStmt(sessionId, ctx.user.id, last.created_at, true),
      messagesDb.recountStmt(sessionId),
    ])
  }

  const userTurn = await messagesDb.lastUserForSession(ctx.db, sessionId)
  if (!userTurn) throw badRequest('This conversation has no user message to answer.', 'nothing_to_regenerate')

  const full = await messagesDb.historyFor(
    ctx.db,
    sessionId,
    ctx.policy.historyMaxTurns,
    LIMITS.maxTotalChars,
  )
  // After the truncation the trailing entry is the turn being re-answered; it
  // moves out of `history` and into the enriched current turn.
  if (full.length > 0 && full[full.length - 1]?.role === 'user') full.pop()

  const files = await filesDb.listForMessage(ctx.db, userTurn.id)
  assertVisionOk(files, model)

  const text = await withDocuments(ctx, files, userTurn.message_content)
  return {
    history: full,
    text,
    userText: userTurn.message_content,
    images: await imageParts(ctx, files),
    userMessageId: null,
    promptChars: full.reduce((n, m) => n + m.content.length, 0) + text.length,
    promptHash: (await sha256Hex(userTurn.message_content)).slice(0, 16),
    attachmentCount: files.length,
  }
}

/** Drops `messageId` and everything after it, for an edited earlier turn. */
async function truncateFrom(ctx: AuthedContext, sessionId: string, messageId: string): Promise<void> {
  const target = await messagesDb.get(ctx.db, messageId)
  // Both the session and the owner must match: without the second check, a
  // valid message id from another user's chat would truncate by timestamp.
  if (!target || target.session_id !== sessionId || target.user_id !== ctx.user.id) {
    throw notFound('That message does not exist in this conversation.', 'message_not_found')
  }
  await batch(ctx.db, [
    messagesDb.truncateFromStmt(sessionId, ctx.user.id, target.created_at, true),
    messagesDb.recountStmt(sessionId),
  ])
}

/**
 * Loads and authorises the turn's attachments.
 *
 * Every id is re-read from D1 scoped to the caller, so an id guessed or copied
 * from elsewhere resolves to nothing. Files still uploading are refused rather
 * than silently dropped — sending a message that quietly ignored the PDF the
 * user attached is worse than making them press send again.
 */
async function loadAttachments(
  ctx: AuthedContext,
  ids: string[],
  model: ModelSpec,
): Promise<FileRow[]> {
  if (ids.length === 0) return []
  if (ids.length > ctx.policy.maxAttachmentsPerMessage) {
    throw badRequest(
      `Up to ${ctx.policy.maxAttachmentsPerMessage} attachments per message.`,
      'too_many_attachments',
    )
  }

  const rows = await filesDb.getManyOwned(ctx.db, ids, ctx.user.id)
  if (rows.length !== ids.length) {
    throw notFound('One of those attachments is no longer available.', 'attachment_not_found')
  }
  const unfinished = rows.find((r) => r.upload_status !== 'stored')
  if (unfinished) {
    throw badRequest(
      `"${unfinished.original_filename}" has not finished uploading.`,
      'attachment_not_ready',
    )
  }

  assertVisionOk(rows, model)
  return rows
}

function assertVisionOk(files: FileRow[], model: ModelSpec): void {
  if (files.some((f) => f.file_type === 'image') && !model.vision) {
    // Refused here rather than upstream: an AgentRouter 400 about content parts
    // is not something a user can act on, and this message is.
    throw badRequest(NO_VISION_MESSAGE, 'model_no_vision')
  }
}

/** Prepends the bounded document-context block, when there are PDFs. */
async function withDocuments(ctx: AuthedContext, files: FileRow[], content: string): Promise<string> {
  if (!files.some((f) => f.file_type === 'pdf')) return content

  const bucket = requireBucket(ctx.env.FILES)
  const { text, unavailable } = await buildDocumentContext(
    bucket,
    files,
    content,
    ctx.policy.pdfContextChars,
  )

  const notes: string[] = []
  if (unavailable.length > 0) {
    // Told to the model, not hidden: it can then say "I could not read X"
    // instead of inventing an answer about a document it never saw.
    notes.push(
      `Note: text could not be extracted from ${unavailable.map((n) => `"${n}"`).join(', ')}. ` +
        'Say so if the question depends on it.',
    )
  }

  return [text, ...notes, content].filter((part) => part.length > 0).join('\n\n')
}

async function imageParts(ctx: AuthedContext, files: FileRow[]): Promise<ContentPart[]> {
  const images = files.filter((f) => f.file_type === 'image')
  if (images.length === 0) return []

  const bucket = requireBucket(ctx.env.FILES)
  const parts: ContentPart[] = []
  for (const file of images) {
    const url = await imageDataUrl(bucket, file)
    // A missing object means the row and R2 disagree. Skipping keeps the turn
    // usable; the alternative is failing a message over one lost thumbnail.
    if (url) parts.push({ type: 'image_url', image_url: { url, detail: 'auto' } })
    else console.warn('[chatddb] image row %s has no object at %s', file.id, file.r2_key)
  }
  return parts
}

/**
 * Assembles the upstream message list.
 *
 * Note the shape of the last turn: plain string when there are no images,
 * content parts when there are. Text-only requests therefore keep exactly the
 * body AgentRouter is known to accept — the multimodal form is only used when it
 * has to be, and only for a model whose `vision` flag was actually verified.
 */
function buildUpstreamMessages(ctx: AuthedContext, turn: Turn): ChatMessage[] {
  const system = ctx.env.SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT
  const messages: ChatMessage[] = [{ role: 'system', content: system }]

  for (const entry of turn.history) {
    if (entry.role === 'system') continue
    messages.push({ role: entry.role, content: entry.content })
  }

  messages.push({
    role: 'user',
    content:
      turn.images.length > 0
        ? [{ type: 'text', text: turn.text } as ContentPart, ...turn.images]
        : turn.text,
  })
  return messages
}

// ---------------------------------------------------------------------------
// Post-stream persistence
// ---------------------------------------------------------------------------

/**
 * Writes the assistant turn once the stream is over.
 *
 * Runs in `waitUntil`, so a slow or failing D1 write cannot delay a token or
 * truncate a reply. An aborted or errored turn is still recorded — with
 * `finish_reason='aborted'` or `error` set — because `historyFor` filters those
 * out of future context while the admin inspector can still show what happened.
 *
 * The session title is settled here too, for the same reason: naming costs an
 * extra upstream round-trip, and nothing about it should be in front of the
 * user's first token.
 */
async function persistAssistant(
  ctx: AuthedContext,
  session: sessionsDb.SessionRow,
  chain: UpstreamConfig[],
  attempt: UpstreamAttempt,
  model: ModelSpec,
  turn: Turn,
  result: StreamResult,
): Promise<void> {
  const sessionId = session.id
  const fromUpstream = result.usage !== null
  // When upstream reports nothing, both numbers are estimates from character
  // counts, and `token_source` says so — the admin UI labels them rather than
  // presenting a guess as a billing figure.
  const prompt = result.usage?.promptTokens ?? Math.ceil(turn.promptChars / 4)
  const completion = result.usage?.completionTokens ?? messagesDb.estimateTokens(result.text)
  const total = result.usage?.totalTokens ?? prompt + completion

  const inserted = messagesDb.insertStmt({
    sessionId,
    userId: ctx.user.id,
    role: 'assistant',
    content: result.text,
    // What actually answered, not what was asked for: on a crossover this is
    // `gpt-5.5` / `freemodel`, so the admin inspector and any later token
    // accounting describe the request that really happened.
    model: attempt.model,
    modelProvider: attempt.provider,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    tokenSource: fromUpstream ? 'upstream' : 'estimate',
    finishReason: result.finishReason,
    error: result.error,
  })

  // Awaited before the batch so the retitle can join the same transaction. A
  // null title (declined, failed, or not needed) simply adds no statement.
  //
  // After a crossover, only the gateway that answered is asked for a name. The
  // primary just failed seconds ago; walking the chain from the top would spend
  // a 20-second timeout re-learning that before getting to the one that works.
  const title = await autoTitle(session, attempt.crossedOver ? [attempt.cfg] : chain, turn, result)

  const statements = [inserted.stmt, sessionsDb.touchStmt(sessionId, 1, model.id)]
  if (title) statements.push(sessionsDb.retitleStmt(sessionId, title))

  try {
    await batch(ctx.db, statements)
  } catch (err) {
    // Nothing left to salvage: the user has already read the reply. Log loudly
    // so the gap between what they saw and what we stored is discoverable.
    console.error('[chatddb] failed to persist assistant turn for session %s: %s', sessionId, err)
  }
}

/**
 * A model-written name for a session that does not have one yet, or null.
 *
 * Only the first completed exchange is titled. A later pass would cost an
 * upstream call per turn to rename a chat the user is already navigating by, and
 * `retitleStmt` accepts `auto` rows precisely so a *future* deliberate re-title
 * remains possible — not so every turn takes one.
 *
 * Every guard here returns null rather than throwing: this runs after the user
 * has read their reply, and a session keeping its `makeTitle` placeholder is a
 * cosmetic problem, not a failed request.
 */
async function autoTitle(
  session: sessionsDb.SessionRow,
  chain: UpstreamConfig[],
  turn: Turn,
  result: StreamResult,
): Promise<string | null> {
  // The user owns this name, or the model already chose one.
  if (session.title_source !== 'placeholder') return null
  // A regenerate or an edit of an existing chat — not a first exchange.
  if (session.message_count > 0) return null
  // Nothing worth naming: an empty, aborted, or failed answer.
  if (result.error || !result.text.trim()) return null
  if (!turn.userText.trim()) return null

  // No signal is passed: the client's connection is closed by now, and on an
  // aborted stream it is already aborted — passing it would cancel every title
  // for exactly the turns that still deserve one.
  return titleWithFailover(chain, { user: turn.userText, assistant: result.text })
}

/**
 * Records that a turn never got an answer, for an upstream failure.
 *
 * `failed` is the gateway that refused last, so a row for a turn that exhausted
 * both gateways names the backup rather than implying the primary was the only
 * thing tried.
 */
async function persistFailure(
  ctx: AuthedContext,
  sessionId: string,
  model: ModelSpec,
  failed: UpstreamConfig,
  message: string,
): Promise<void> {
  const inserted = messagesDb.insertStmt({
    sessionId,
    userId: ctx.user.id,
    role: 'assistant',
    content: '',
    model: failed.model,
    modelProvider: failed.provider,
    finishReason: 'error',
    error: message.slice(0, 1_000),
  })
  try {
    await batch(ctx.db, [inserted.stmt, sessionsDb.touchStmt(sessionId, 1, model.id)])
  } catch (err) {
    console.error('[chatddb] failed to record upstream failure: %s', err)
  }
}
