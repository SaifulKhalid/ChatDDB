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

import type { ChatMessage, ContentPart, ToolCall, ToolDefinition } from '../adapters/types.ts'
import { peekToolCalls, toClientStream, type StreamResult } from '../sse.ts'
import { ApiError, badRequest, corsHeaders, notFound } from '../lib/http.ts'
import { MAX_PROMPT_CHARS, resolveImageProviders } from '../images.ts'
import {
  generateAndStore,
  imageGeneratedLog,
  limitImage,
  requireImageProviders,
} from './images.ts'
import { LIMITS, readJsonBody, optionalString, requireString, requireUuid, isUuid } from '../lib/validate.ts'
import { batch, requireBucket } from '../db/client.ts'
import * as activity from '../db/activity.ts'
import * as messagesDb from '../db/messages.ts'
import * as sessionsDb from '../db/sessions.ts'
import * as filesDb from '../db/files.ts'
import * as ratelimit from '../lib/ratelimit.ts'
import * as suspicious from '../lib/suspicious.ts'
import { buildDocumentContext, imageDataUrl } from '../lib/files/context.ts'
import {
  orchestrateChat,
  resolveService,
  getAdapter,
  resolveProviderCredentials,
  type OrchestratedResult,
} from '../orchestrator.ts'
import { ClassifiedUpstreamError } from '../adapters/errors.ts'
import type { AiServiceRow, ServiceCapabilities } from '../db/aiRouting.ts'
import { sha256Hex } from '../lib/hash.ts'
import type { AuthedContext } from '../auth/middleware.ts'
import type { FileRow } from '../db/files.ts'
import type { WorkerEnv } from '../env.ts'

const DEFAULT_SYSTEM_PROMPT = [
  'You are ChatDDB, a helpful, knowledgeable AI assistant.',
  'Answer accurately and get to the point; expand only when the question needs it.',
  'Use Markdown — fenced code blocks with a language tag, tables where they help.',
  'If you are unsure or lack the information, say so rather than guessing.',
].join(' ')

const NO_VISION_MESSAGE =
  'This model does not support image analysis. Please select a vision-capable model.'

// ---------------------------------------------------------------------------
// The generate_image tool
// ---------------------------------------------------------------------------
//
// Everything the tool is — its schema, the rule for when it may fire, the
// wording of its results, and the loop that runs it — lives in this section and
// nowhere else. It is offered only when image generation is actually configured,
// so a deployment without the `AI` binding sends exactly the request body it
// always did.
//
// Verified before any of it was written: `npm run probe:tools`, 5 runs per case
// against `gpt-5.6-sol` through the provider — 10/10 tool calls on explicit and
// implicit image requests, 5/5 restraint on a question with no visual intent,
// 5/5 clean round trips in both the success and unavailable directions, and 5/5
// over a streaming request. Re-run it after touching anything below.

const IMAGE_TOOL_NAME = 'generate_image'

/**
 * The tool as the gateway sees it.
 *
 * `additionalProperties: false` and a single required field on purpose: the only
 * thing the Worker can act on is a prompt string, and a schema that admits more
 * invites the model to send size or style fields that would be silently dropped.
 */
const IMAGE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: IMAGE_TOOL_NAME,
    description:
      'Generate an image and attach it to your reply. Call this only when the user is ' +
      'asking to see, visualise, or be shown something — never to decorate an answer.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'A complete, self-contained description of the image to generate, in English. ' +
            'Compose it from the conversation; the image model sees nothing but this string.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
}

/**
 * When the tool may fire, appended to whichever system prompt resolves.
 *
 * ## Why it is appended rather than written into `DEFAULT_SYSTEM_PROMPT`
 *
 * `buildUpstreamMessages` picks `SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT` — an
 * either/or, not a merge. Putting this clause in the default would mean any
 * deployment that sets a custom `SYSTEM_PROMPT` hands the model a working image
 * generator with no instruction about when to use it, which is worse than not
 * shipping the feature: the budget behind it is shared by every user of the
 * deployment and resets once a day. So the clause is appended after the base
 * prompt, whichever base that turns out to be, and an operator cannot drop it by
 * accident. This is option (a) of the two the task set out.
 *
 * It is *guidance*, not enforcement. `limitToolImage` is the enforcement, and it
 * exists because a sentence in a prompt has never been a spending control.
 *
 * The last line is not stylistic, and it is an ordering rule rather than a
 * wording one. `peekToolCalls` commits to "this turn is prose" on the first
 * content frame it sees (`sse.ts:547`), so a model that introduces the image
 * *before* calling the tool has its call discarded and answers with a sentence
 * promising a picture that never arrives. Production showed this on 29% of
 * image-intent turns. Nothing about the introduction itself belongs here:
 * `TOOL_RESULT_OK` carries it on the round where an image actually exists to
 * introduce, which is also where the probe's phases 3 and 4 assert it — a model
 * told the image is "already attached" often answers with nothing at all, and one
 * told only "ok" invents `![...](attachment://...)` for a file that does not
 * exist. Both are fixed there, and were only ever duplicated here.
 */
const TOOL_USE_CLAUSE = [
  'You can attach one generated image to a reply by calling the `generate_image` tool.',
  'Call it only when the user asks to see, visualise, draw, or be shown something —',
  'never to illustrate an answer nobody asked to see.',
  'Compose the `prompt` argument yourself from the conversation: the image model reads that',
  'string and nothing else, so it must stand alone.',
  'At most one image per reply — every call spends a small budget shared by all users.',
  'Call the tool with no text before it — write nothing until the tool result comes back.',
].join(' ')

// ---------------------------------------------------------------------------
// SVG diagrams
// ---------------------------------------------------------------------------
//
// The other way to answer with a picture, and the one that works for the
// audience this deployment actually has. Most image requests here are labelled
// technical figures — pole-zero plots, Bode plots, circuits, free-body diagrams
// — and no diffusion model can draw one. It has no symbolic model of an axis, so
// it generates texture that resembles a diagram: the report that started this
// was a pole-zero plot rendered as a vertical stroke, a stray arrow, and the
// handwriting-shaped noise "= 2".
//
// Drawing in SVG inverts that. The model computes coordinates and the browser
// renders them, so the figure is correct by construction or visibly wrong, never
// plausibly wrong.
//
// ## Why this is not a tool
//
// `generate_image` needs to be one: only the Worker can call Workers AI and
// write R2. A figure needs no server execution at all — the SVG *is* the reply
// text. Making it a tool would buy nothing and cost a full extra round trip in
// front of the user's first token, plus a rate limiter, an R2 write, a `files`
// row and a `persistAssistant` change. As prose it also streams.
//
// What it does need is `worker/lib/figureGate.ts`, which holds the fenced block
// back until it is complete and sanitised, and `src/components/SvgFigure.tsx`,
// which draws it. Verified before any of this was written: `npm run probe:svg`.

/** `'false'` disarms; anything else, including unset, leaves figures on. */
function diagramsEnabled(env: WorkerEnv): boolean {
  return env.SVG_DIAGRAMS !== 'false'
}

/**
 * How to draw, appended to whichever system prompt resolves.
 *
 * Appended for the same reason `TOOL_USE_CLAUSE` is: `buildUpstreamMessages`
 * picks `SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT`, an either/or rather than a
 * merge, so a clause written into the default would vanish for any deployment
 * with a custom prompt. Here that would not cost money, but it would produce
 * something worse than the feature being off: the renderer would still draw any
 * ```` ```svg ```` block, so a model with no drawing rules would emit figures
 * hard-coded to black-on-white, invisible in the dark theme.
 *
 * Every rule below earned its place in `npm run probe:svg` — each one's absence
 * produced a specific defect across the five probe figures. `currentColor` for
 * dark-theme legibility, `viewBox` against clipping, the offset instruction
 * against labels landing on top of the marks they name, the explicit font-size
 * against a default that renders at 16px in a 300-unit viewBox.
 *
 * The restraint paragraph is first because it is the part that matters most in
 * production. A model that draws a figure for every question is worse than one
 * that draws none.
 */
const DIAGRAM_CLAUSE = [
  'When a figure would carry information your prose cannot — a plot, a circuit, a free-body',
  'diagram, a signal-flow graph, a labelled geometry, a state machine — draw it as SVG inside a',
  '```svg fenced code block. It is rendered as a real figure, not printed as code.',
  'Draw only when the figure is the answer or a necessary part of it. Never to decorate, and never',
  'for something Markdown already renders: a table, a list, or an equation.',
  'Most questions need no figure at all.',
  '',
  'When you do draw:',
  '- One `svg` block per figure, holding a single <svg> root with an explicit viewBox.',
  '  Do not set width or height on it.',
  '- Open the root with a <title> naming the figure. It becomes the caption and the accessible name.',
  '- Use stroke="currentColor" and fill="currentColor" for axes, rules and text, so the figure is',
  '  legible in both the light and dark themes. Use a named colour only to pick plotted data out',
  '  from the axes, and never paint a background.',
  '- Give every axis tick marks with numeric labels, and a name.',
  '- Label every plotted feature, offset from the mark it names so nothing overlaps.',
  '- Set font-size explicitly in user units, 11-14 for labels. Never rely on the default.',
  '- No <script>, no event handlers, no <image>, no external references. They are stripped before',
  '  the figure is shown, so a figure that depends on one arrives broken.',
  '- Compute coordinates exactly. A pole at s = -3 belongs at the tick marked -3.',
].join('\n')

/**
 * Which of the two visual paths to take, appended only when both are available.
 *
 * Without it the two clauses contradict each other — `TOOL_USE_CLAUSE` says to
 * call the tool when the user asks to be shown something, which is also exactly
 * when a diagram is wanted. The distinction is not "technical vs artistic" as
 * such but whether the picture's coordinates carry meaning, and the wording says
 * so plainly, including *why* the tool is the wrong instrument, because a model
 * told only "don't" tends to find an exception.
 */
const VISUAL_ROUTING_CLAUSE = [
  'You have two ways to produce a picture and they are not interchangeable.',
  'Draw SVG whenever the positions in the picture mean something: plots, schematics, diagrams,',
  'geometry, timelines, anything with an axis, a scale or a label.',
  '`generate_image` cannot draw these — it is a diffusion model with no symbolic notion of an axis,',
  'so it returns a convincing-looking figure with the numbers in the wrong places.',
  'Call `generate_image` only for photographic, artistic or illustrative pictures,',
  'where nothing depends on a value being at a particular coordinate.',
].join(' ')

/** Handed back when the image exists. See the note on `TOOL_USE_CLAUSE`. */
const TOOL_RESULT_OK = JSON.stringify({
  status: 'ok',
  instruction:
    'The image has been generated and attached to your reply. Introduce it in one short ' +
    'sentence. Do not write a Markdown image link — the attachment renders on its own.',
})

/**
 * Handed back when no image was produced, for any reason.
 *
 * The `reason` is shown to the user in the model's own words, so it has to be
 * something a person can act on — "resets at midnight UTC" rather than a status
 * code. `Do not retry` matters because the loop below deliberately stops
 * offering the tool after the first round; a model that retried would spend a
 * round being refused instead of explaining itself.
 */
function toolResultUnavailable(reason: string): string {
  return JSON.stringify({
    status: 'unavailable',
    reason,
    instruction:
      'No image was generated and nothing is attached. Tell the user plainly that you could ' +
      'not make the image and why. Do not retry the tool.',
  })
}

/**
 * How many times the model may be handed a tool result before we stop.
 *
 * In practice the loop runs once: the follow-up request deliberately omits
 * `tools`, so a well-behaved gateway cannot produce a second call. This is the
 * backstop for one that does anyway — and the generation itself is capped
 * independently, at one image per turn, by the `file` check in `runToolLoop`.
 */
const MAX_TOOL_ROUNDS = 3

interface ChatBody {
  sessionId?: string
  content?: string
  attachments: string[]
  service?: string
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
    service: optionalString(raw.service, 'service', { max: 100 }),
    model: optionalString(raw.model, 'model', { max: 100 }),
    replaceFromMessageId:
      raw.replaceFromMessageId === undefined || raw.replaceFromMessageId === null
        ? undefined
        : requireUuid(raw.replaceFromMessageId, 'replaceFromMessageId'),
    regenerate,
  }
}

export async function postChat(ctx: AuthedContext): Promise<Response> {
  const body = parseBody(await readJsonBody(ctx.request))

  // Pre-load attachment rows to verify readiness and determine file types
  let attachmentRows: FileRow[] = []
  if (body.attachments.length > 0) {
    if (body.attachments.length > ctx.policy.maxAttachmentsPerMessage) {
      throw badRequest(
        `Up to ${ctx.policy.maxAttachmentsPerMessage} attachments per message.`,
        'too_many_attachments',
      )
    }
    attachmentRows = await filesDb.getManyOwned(ctx.db, body.attachments, ctx.user.id)
    if (attachmentRows.length !== body.attachments.length) {
      throw notFound('One of those attachments is no longer available.', 'attachment_not_found')
    }
    const unfinished = attachmentRows.find((r) => r.upload_status !== 'stored')
    if (unfinished) {
      throw badRequest(
        `"${unfinished.original_filename}" has not finished uploading.`,
        'attachment_not_ready',
      )
    }
  }

  const hasImages = attachmentRows.some((f) => f.file_type === 'image')
  const hasDocuments = attachmentRows.some((f) => f.file_type === 'pdf')

  // Resolve public AI service dynamically from D1
  const service = await resolveService(ctx.db, ctx.env, body.service || body.model, {
    content: body.content,
    hasImages,
  })

  // Verify vision capability if explicit turn carries images
  assertVisionOk(attachmentRows, service)

  await limitChat(ctx)

  const session = await resolveSession(ctx, body, service.public_name)
  const turn = await prepareTurn(ctx, body, session.id, service, attachmentRows)

  // Offered only when image providers exist
  const toolsArmed = resolveImageProviders(ctx.env).length > 0
  const upstream = buildUpstreamMessages(ctx, turn, toolsArmed)

  let outcome: OrchestratedResult
  let generated: filesDb.PublicFile | null = null

  try {
    outcome = await orchestrateChat(ctx.db, ctx.env, {
      serviceOrKey: service.key,
      content: body.content,
      messages: upstream,
      hasImages,
      hasDocuments,
      tools: toolsArmed ? [IMAGE_TOOL] : undefined,
      clientSignal: ctx.request.signal,
    })

    if (toolsArmed) {
      const toolRes = await runToolLoop(ctx, outcome, upstream, session.id)
      outcome = { ...outcome, res: toolRes.attemptRes }
      generated = toolRes.file
    }
  } catch (err) {
    if (err instanceof ClassifiedUpstreamError) {
      ctx.exec.waitUntil(
        persistFailure(ctx, session.id, service.public_name, err.classification.publicMessage),
      )
      console.error(
        '[chatddb] upstream error for service=%s: %s',
        service.public_name,
        err.classification.internalDiagnostic,
      )
      throw new ApiError(
        err.classification.publicStatus,
        err.classification.category,
        err.classification.publicMessage,
      )
    }
    throw err
  }

  const attached = generated
  const stream = toClientStream(outcome.res, (result) => {
    ctx.exec.waitUntil(
      persistAssistant(
        ctx,
        session,
        service.public_name,
        outcome.upstreamModelId,
        outcome.provider.key,
        turn,
        result,
        attached,
      ),
    )
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      // Public AI service name only: NEVER leaks upstream model IDs
      'X-ChatDDB-Model': service.public_name,
      'X-ChatDDB-Session-Id': session.id,
      ...(turn.userMessageId ? { 'X-ChatDDB-Message-Id': turn.userMessageId } : {}),
      ...(attached
        ? {
            'X-ChatDDB-Generated-File': attached.id,
            'X-ChatDDB-Generated-File-JSON': encodeURIComponent(JSON.stringify(attached)),
          }
        : {}),
      ...corsHeaders(ctx.request, ctx.env),
    },
  })
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

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
  service: AiServiceRow,
  preloadedFiles?: FileRow[],
): Promise<Turn> {
  if (body.regenerate) return prepareRegenerate(ctx, sessionId, service)

  const content = body.content as string
  const files = preloadedFiles ?? (await loadAttachments(ctx, body.attachments, service))

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
    model: service.public_name,
    modelProvider: null,
    attachmentCount: files.length,
    createdAt: now,
  })

  const promptHash = (await sha256Hex(content)).slice(0, 16)
  const statements = [
    inserted.stmt,
    sessionsDb.touchStmt(sessionId, 1, service.public_name, now),
    activity.logStmt({
      userId: ctx.user.id,
      action: 'message_sent',
      metadata: {
        sessionId,
        model: service.public_name,
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
 */
async function prepareRegenerate(
  ctx: AuthedContext,
  sessionId: string,
  service: AiServiceRow,
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
  if (full.length > 0 && full[full.length - 1]?.role === 'user') full.pop()

  const files = await filesDb.listForMessage(ctx.db, userTurn.id)
  assertVisionOk(files, service)

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
 */
async function loadAttachments(
  ctx: AuthedContext,
  ids: string[],
  service: AiServiceRow,
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

  assertVisionOk(rows, service)
  return rows
}

function assertVisionOk(files: FileRow[], service: AiServiceRow): void {
  let caps: ServiceCapabilities = {}
  try {
    caps = JSON.parse(service.capabilities) as ServiceCapabilities
  } catch {
    caps = {}
  }
  if (files.some((f) => f.file_type === 'image') && !caps.vision) {
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
 * body the provider is known to accept — the multimodal form is only used when it
 * has to be, and only for a model whose `vision` flag was actually verified.
 *
 * The capability clauses are appended to whichever base prompt resolved, rather
 * than written into the default. The base is still all-or-nothing — a custom
 * `SYSTEM_PROMPT` replaces the default outright — but the constraints are no
 * longer part of that choice, because an operator dropping them would leave the
 * model holding a budget-spending tool with no instruction about when to use it,
 * and a renderer that draws figures with no instruction about how. See the notes
 * on the clauses themselves.
 *
 * The routing clause is appended only when both paths are live, since it exists
 * purely to settle which one a request belongs to.
 */
function buildUpstreamMessages(ctx: AuthedContext, turn: Turn, toolsArmed = false): ChatMessage[] {
  const clauses = [ctx.env.SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT]
  const drawing = diagramsEnabled(ctx.env)
  if (toolsArmed) clauses.push(TOOL_USE_CLAUSE)
  if (drawing) clauses.push(DIAGRAM_CLAUSE)
  if (toolsArmed && drawing) clauses.push(VISUAL_ROUTING_CLAUSE)

  const messages: ChatMessage[] = [{ role: 'system', content: clauses.join('\n\n') }]

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
// Tool execution
// ---------------------------------------------------------------------------

/** What the tool rounds settled on: the response to stream, and any image made. */
interface ToolOutcome {
  attemptRes: Response
  file: filesDb.PublicFile | null
}

async function runToolLoop(
  ctx: AuthedContext,
  outcome: OrchestratedResult,
  messages: ChatMessage[],
  sessionId: string,
): Promise<ToolOutcome> {
  let currentRes = outcome.res
  let file: filesDb.PublicFile | null = null

  const adapter = getAdapter(outcome.provider.adapter)
  const creds = resolveProviderCredentials(outcome.provider, ctx.env)

  let routeConfig: {
    tokenParam?: 'max_tokens' | 'max_completion_tokens'
    maxOutputTokens?: number
    reasoningEffort?: string
    sendReasoningEffort?: boolean
  } = {}

  if (outcome.route.configuration) {
    try {
      routeConfig = JSON.parse(outcome.route.configuration) as typeof routeConfig
    } catch {
      routeConfig = {}
    }
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const peek = await peekToolCalls(currentRes)
    if (peek.kind === 'text') return { attemptRes: peek.res, file }

    messages.push({ role: 'assistant', content: null, tool_calls: peek.calls })

    for (const call of peek.calls) {
      const { payload, generated } = await runToolCall(ctx, sessionId, call, file !== null)
      if (generated) file = generated
      messages.push({ role: 'tool', tool_call_id: call.id, content: payload })
    }

    currentRes = await adapter.executeChat(outcome.provider, creds, {
      upstreamModel: outcome.route.upstream_model_id,
      messages,
      clientSignal: ctx.request.signal,
      configuration: routeConfig,
      timeoutMs: outcome.provider.timeout_ms,
    })
  }

  console.warn('[chatddb] tool loop hit %d rounds for session %s', MAX_TOOL_ROUNDS, sessionId)
  const last = await peekToolCalls(currentRes)
  return {
    attemptRes: last.kind === 'text' ? last.res : currentRes,
    file,
  }
}

/**
 * Executes one call and returns the JSON the model gets back.
 *
 * Never throws. Every failure — a bad argument, a spent budget, a provider that
 * refused — becomes an `unavailable` result carrying a reason in plain words,
 * because the alternative is a turn that dies after the user's message was
 * already committed. The model then explains it, which the probe's phase 4
 * confirms it does reliably.
 */
async function runToolCall(
  ctx: AuthedContext,
  sessionId: string,
  call: ToolCall,
  alreadyGenerated: boolean,
): Promise<{ payload: string; generated: filesDb.PublicFile | null }> {
  if (call.function.name !== IMAGE_TOOL_NAME) {
    // Nothing else is offered, so this is a gateway echoing a tool we never sent
    // or a model inventing one. Answered rather than ignored: an unanswered
    // `tool_call_id` makes the next request malformed.
    return {
      payload: toolResultUnavailable(`There is no \`${call.function.name}\` tool available.`),
      generated: null,
    }
  }

  if (alreadyGenerated) {
    return {
      payload: toolResultUnavailable('Only one image can be attached to a reply.'),
      generated: null,
    }
  }

  let prompt = ''
  try {
    const args = JSON.parse(call.function.arguments || '{}') as { prompt?: unknown }
    if (typeof args.prompt === 'string') prompt = args.prompt.trim()
  } catch {
    /* reported as an unusable prompt below */
  }
  if (!prompt) {
    return {
      payload: toolResultUnavailable('The image request arrived without a usable prompt.'),
      generated: null,
    }
  }
  // The model has no reason to know flux-1-schnell's ceiling, and a prompt over
  // it would be refused upstream after the budget was already spent.
  prompt = prompt.slice(0, MAX_PROMPT_CHARS)

  // Both budgets, tighter one first. `limitToolImage` is the one likely to
  // refuse, and consuming the shared per-user counter before finding that out
  // would cost the user an image they could otherwise have asked for by hand.
  try {
    await limitToolImage(ctx)
    await limitImage(ctx)
  } catch (err) {
    if (err instanceof ApiError) return { payload: toolResultUnavailable(err.message), generated: null }
    throw err
  }

  try {
    const providers = requireImageProviders(ctx)
    const bucket = requireBucket(ctx.env.FILES)
    const { image, file } = await generateAndStore(ctx, bucket, providers, sessionId, prompt)

    // The same row `POST /api/images` writes, with `kind: 'tool'` as the only
    // difference — so admin visibility does not depend on which path drew it.
    ctx.exec.waitUntil(
      activity.log(
        ctx.db,
        imageGeneratedLog({
          ctx,
          sessionId,
          fileId: file.id,
          image,
          steps: providers[0].provider === 'workers-ai' ? providers[0].steps : undefined,
          kind: 'tool',
        }),
      ),
    )
    return { payload: TOOL_RESULT_OK, generated: file }
  } catch (err) {
    const message = err instanceof ApiError ? err.message : 'Image generation failed.'
    console.error('[chatddb] generate_image tool failed for session %s: %s', sessionId, err)
    ctx.exec.waitUntil(
      activity.log(ctx.db, {
        userId: ctx.user.id,
        action: 'image_failed',
        severity: 'warn',
        metadata: { sessionId, kind: 'tool', reason: err instanceof ApiError ? err.type : 'unknown' },
        ipHash: ctx.ipHash,
        userAgent: ctx.userAgent,
      }),
    )
    return { payload: toolResultUnavailable(message), generated: null }
  }
}

/**
 * The tool's own daily budget, on top of the user's ordinary image budget.
 *
 * A separate `'tool_image'` action rather than a share of `'image'`, so the two
 * cannot drain each other: a tool-triggered generation spends *both*, while the
 * composer button spends only the human one. Deliberately a quarter of it by
 * default — see `RATE_TOOL_IMAGE_PER_DAY` in `env.ts`.
 *
 * The reason it exists at all is that `TOOL_USE_CLAUSE` is a sentence in a
 * prompt. A model that reads it differently than intended, on any given day,
 * must not be able to spend the whole deployment's shared allowance before
 * anyone notices; prompting is a hint and this is the budget.
 *
 * Minute-window only through `limitImage`: this cap is about the daily total,
 * and the burst is already bounded by the same call.
 */
async function limitToolImage(ctx: AuthedContext): Promise<void> {
  const verdict = await ratelimit.consume(ctx.db, `user:${ctx.user.id}`, 'tool_image', [
    { kind: 'day', max: ctx.policy.rateToolImagePerDay },
  ])
  if (verdict.allowed) return

  await activity.log(ctx.db, {
    userId: ctx.user.id,
    action: 'rate_limited',
    severity: 'warn',
    metadata: { action: 'tool_image', window: verdict.kind, limit: verdict.limit, count: verdict.count },
    ipHash: ctx.ipHash,
    userAgent: ctx.userAgent,
  })
  // Phrased for the model to relay, not for an HTTP client to parse: this
  // message is on its way into `toolResultUnavailable` and then into a sentence
  // the user reads.
  throw new ApiError(
    429,
    'tool_image_rate_limited',
    `You have reached today's limit of ${ctx.policy.rateToolImagePerDay} generated images. ` +
      'It resets at midnight UTC.',
  )
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
 *
 * `file` is the image the `generate_image` tool drew during this turn, if it
 * fired. It attaches to the *assistant* row rather than the user's, so
 * `listForSession` groups it under the reply that describes it — the same shape
 * `POST /api/images` already writes, and therefore no change at all to the
 * transcript path that reads it back.
 */
async function persistAssistant(
  ctx: AuthedContext,
  session: sessionsDb.SessionRow,
  serviceName: string,
  _upstreamModelId: string,
  providerKey: string,
  turn: Turn,
  result: StreamResult,
  file: filesDb.PublicFile | null,
): Promise<void> {
  const sessionId = session.id
  const fromUpstream = result.usage !== null
  const prompt = result.usage?.promptTokens ?? Math.ceil(turn.promptChars / 4)
  const completion = result.usage?.completionTokens ?? messagesDb.estimateTokens(result.text)
  const total = result.usage?.totalTokens ?? prompt + completion

  if (result.finishReason === 'tool_calls' && !file) {
    console.error(
      '[chatddb] image promised but not attached for session %s: finish_reason=tool_calls with attachment_count=0',
      sessionId,
    )
  }

  const inserted = messagesDb.insertStmt({
    sessionId,
    userId: ctx.user.id,
    role: 'assistant',
    content: result.text,
    model: serviceName, // Public AI service name (e.g. 'ChatGPT')
    modelProvider: providerKey, // Internal provider key for admin inspector only
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    tokenSource: fromUpstream ? 'upstream' : 'estimate',
    finishReason: result.finishReason,
    error: result.error,
    attachmentCount: file ? 1 : 0,
  })

  const title = autoTitle(session, turn, result)

  const statements = [inserted.stmt, sessionsDb.touchStmt(sessionId, 1, serviceName)]
  if (title) statements.push(sessionsDb.retitleStmt(sessionId, title))
  if (file) statements.push(filesDb.attachToMessageStmt([file.id], inserted.id, sessionId, ctx.user.id))

  try {
    await batch(ctx.db, statements)
  } catch (err) {
    console.error('[chatddb] failed to persist assistant turn for session %s: %s', sessionId, err)
  }
}

function autoTitle(
  session: sessionsDb.SessionRow,
  turn: Turn,
  result: StreamResult,
): string | null {
  if (session.title_source !== 'placeholder') return null
  if (session.message_count > 0) return null
  if (result.error || !result.text.trim()) return null
  if (!turn.userText.trim()) return null

  const line = turn.userText.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const words = line.replace(/^[#\-*\d.]+\s*/, '').slice(0, 64).trim()
  return words || 'Conversation'
}

async function persistFailure(
  ctx: AuthedContext,
  sessionId: string,
  serviceName: string,
  message: string,
): Promise<void> {
  const inserted = messagesDb.insertStmt({
    sessionId,
    userId: ctx.user.id,
    role: 'assistant',
    content: '',
    model: serviceName,
    modelProvider: null,
    finishReason: 'error',
    error: message.slice(0, 1_000),
  })
  try {
    await batch(ctx.db, [inserted.stmt, sessionsDb.touchStmt(sessionId, 1, serviceName)])
  } catch (err) {
    console.error('[chatddb] failed to record failure: %s', err)
  }
}
