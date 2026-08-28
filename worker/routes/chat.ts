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
  type ToolCall,
  type ToolDefinition,
  type UpstreamConfig,
} from '../agentrouter.ts'
import {
  chainFor,
  completeWithFailover,
  resolveProviders,
  titleWithFailover,
  type CrossoverReporter,
  type UpstreamAttempt,
} from '../failover.ts'
import { peekToolCalls, toClientStream, type StreamResult } from '../sse.ts'
import { ApiError, badRequest, corsHeaders, json, notConfigured, notFound } from '../lib/http.ts'
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
  resolveModel,
  isKnownModel,
  NO_VISION_MESSAGE,
  MODELS,
  type ModelSpec,
} from '../models.ts'
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
// against `gpt-5.6-sol` through AgentRouter — 10/10 tool calls on explicit and
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

  // Offered only when there is something behind it. With no `AI` binding the
  // request body is byte-for-byte what it was before the tool existed.
  const toolsArmed = resolveImageProviders(ctx.env).length > 0
  const upstream = buildUpstreamMessages(ctx, turn, toolsArmed)

  // The requested id applies to the primary only, and an *explicit* pick drops
  // any backup that would answer with another vendor's model. See `chainFor`.
  const chain = chainFor(providers, model, body.model !== undefined)

  // Which gateway owns a failure below. Advanced on each crossover so
  // `persistFailure` blames the one that actually refused last.
  let failed = chain[0]

  const onCrossover: CrossoverReporter = (from, to, err) => {
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
  }

  let attempt: UpstreamAttempt
  let generated: filesDb.PublicFile | null = null
  try {
    attempt = await completeWithFailover(
      chain,
      upstream,
      ctx.request.signal,
      onCrossover,
      toolsArmed ? [IMAGE_TOOL] : undefined,
    )

    // Runs entirely in front of `toClientStream`, so the invariant that no
    // already-open stream is ever restarted still holds structurally rather than
    // by care — `completeWithFailover` resolves on headers, and nothing below
    // has written a byte to the client yet. See `peekToolCalls` in `sse.ts`.
    if (toolsArmed) {
      const outcome = await runToolLoop(ctx, chain, upstream, attempt, session.id, onCrossover)
      attempt = outcome.attempt
      generated = outcome.file
    }
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

  const attached = generated
  const stream = toClientStream(attempt.res, (result) => {
    ctx.exec.waitUntil(persistAssistant(ctx, session, chain, attempt, model, turn, result, attached))
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Stops intermediate proxies buffering the stream into one blob.
      'X-Accel-Buffering': 'no',
      'X-ChatDDB-Model': model.id,
      ...(attempt.crossedOver
        ? { 'X-ChatDDB-Upstream': attempt.provider, 'X-ChatDDB-Upstream-Model': attempt.model }
        : {}),
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

/** `GET /api/models` — the registry. */
export function getModels(ctx: AuthedContext): Response {
  return json(
    { models: MODELS, default: resolveModel(undefined, ctx.env.API_PROVIDER_MODEL ?? ctx.env.AGENTROUTER_MODEL ?? '').id },
    200,
    ctx.request,
    ctx.env,
  )
}

/**
 * `GET /api/admin/models` — provider's raw model list.
 */
export async function getUpstreamModels(ctx: AuthedContext): Promise<Response> {
  let config
  try {
    config = resolveConfig(ctx.env)
  } catch (err) {
    if (err instanceof NotConfiguredError) throw notConfigured(err.message)
    throw err
  }
  const res = await listModels(config, ctx.request.signal)
  const text = await res.text()
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
  attempt: UpstreamAttempt
  file: filesDb.PublicFile | null
}

/**
 * Runs tool calls until the model answers with prose.
 *
 * ## Where this sits
 *
 * Between `completeWithFailover` and `toClientStream`, which is the only place
 * it can sit. `peekToolCalls` reads far enough into the upstream response to
 * tell a tool call from an answer; on an answer it hands back a replay of that
 * same stream, so the ordinary path loses nothing and the client still gets
 * bytes as they arrive.
 *
 * ## Why the follow-up request omits `tools`
 *
 * The model has had its turn with the tool. Re-offering it invites a second call
 * that the loop would have to spend a round refusing, and every round is another
 * full round trip in front of the user's first token. `MAX_TOOL_ROUNDS` is the
 * backstop for a gateway that produces one anyway.
 *
 * ## At most one image per turn
 *
 * Enforced by the `file` check, not by asking nicely: once something has been
 * generated, every further call in this turn is answered "unavailable" without
 * touching a provider. The rate limits are a per-day budget; this is the
 * per-turn one, and it is what stops a single confused turn from spending five
 * images before the daily cap notices.
 */
async function runToolLoop(
  ctx: AuthedContext,
  chain: UpstreamConfig[],
  messages: ChatMessage[],
  first: UpstreamAttempt,
  sessionId: string,
  onCrossover: CrossoverReporter,
): Promise<ToolOutcome> {
  let attempt = first
  let file: filesDb.PublicFile | null = null

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const peek = await peekToolCalls(attempt.res)
    if (peek.kind === 'text') return { attempt: { ...attempt, res: peek.res }, file }

    // Echoed back verbatim before the results, as the protocol requires: the
    // model matches each result to its call by `tool_call_id`.
    //
    // `content: null` even when the model wrote a sentence before the call.
    // `peekToolCalls` discards that preamble rather than streaming it, so the
    // user never saw it and nothing stored it; claiming it here would leave the
    // model believing it had already introduced an image it has not yet been
    // told exists, and the round below would answer as if mid-sentence.
    messages.push({ role: 'assistant', content: null, tool_calls: peek.calls })

    for (const call of peek.calls) {
      const { payload, generated } = await runToolCall(ctx, sessionId, call, file !== null)
      if (generated) file = generated
      messages.push({ role: 'tool', tool_call_id: call.id, content: payload })
    }

    attempt = await completeWithFailover(chain, messages, ctx.request.signal, onCrossover)
  }

  // The model kept calling tools past the cap. Stream whatever the last response
  // holds rather than looping: it is a real answer more often than not, and
  // `peekToolCalls` has already turned it back into a replayable stream.
  console.warn('[chatddb] tool loop hit %d rounds for session %s', MAX_TOOL_ROUNDS, sessionId)
  const last = await peekToolCalls(attempt.res)
  return {
    attempt: { ...attempt, res: last.kind === 'text' ? last.res : attempt.res },
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
  chain: UpstreamConfig[],
  attempt: UpstreamAttempt,
  model: ModelSpec,
  turn: Turn,
  result: StreamResult,
  file: filesDb.PublicFile | null,
): Promise<void> {
  const sessionId = session.id
  const fromUpstream = result.usage !== null
  // When upstream reports nothing, both numbers are estimates from character
  // counts, and `token_source` says so — the admin UI labels them rather than
  // presenting a guess as a billing figure.
  const prompt = result.usage?.promptTokens ?? Math.ceil(turn.promptChars / 4)
  const completion = result.usage?.completionTokens ?? messagesDb.estimateTokens(result.text)
  const total = result.usage?.totalTokens ?? prompt + completion

  // A turn that ended in `tool_calls` with nothing attached is not a turn that
  // ran a tool and failed — every failure inside `runToolCall` logs `image_failed`
  // or moves a rate counter. It means the call never produced an image at all,
  // and in production the cause was always the same: `peekToolCalls` saw prose
  // first, returned `kind: 'text'`, and replayed the upstream stream verbatim —
  // carrying the abandoned `tool_calls` frames and this very finish reason
  // through to here. The user reads a sentence promising an image that was
  // generated, billed, and dropped. `TOOL_USE_CLAUSE` now forbids the preamble
  // that triggers it; this is the check that says whether that held.
  //
  // The round-cap path above can reach the same state, and logs its own warning
  // first, so the two are distinguishable in a log tail.
  //
  // Checked here because both values are already in hand: a comparison, not a
  // query. Kept as a permanent detector rather than a one-off — the signature is
  // exact, and the failure is otherwise silent by construction.
  if (result.finishReason === 'tool_calls' && !file) {
    console.error(
      '[chatddb] image promised but not attached for session %s: finish_reason=tool_calls with attachment_count=0 — the tool call never ran (see peekToolCalls in sse.ts)',
      sessionId,
    )
  }

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
    attachmentCount: file ? 1 : 0,
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
  // The file row already exists and is already `stored` — the tool wrote it
  // mid-turn. All that is left is pointing it at a message id that could not be
  // known until now, which is why this cannot happen at generation time.
  if (file) statements.push(filesDb.attachToMessageStmt([file.id], inserted.id, sessionId, ctx.user.id))

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
