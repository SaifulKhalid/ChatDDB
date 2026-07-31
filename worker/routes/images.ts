/**
 * `POST /api/images` — text to image, on Workers AI.
 *
 * The second route that spends money, and the only one whose budget is shared:
 * `/api/chat` bills per key, but the image allowance is 10,000 neurons a day for
 * the whole *account*, drained by whichever signed-in user gets there first. So
 * the per-user limits here are tight (3/min, 20/day by default) and deliberately
 * not the chat limits.
 *
 * ## Shape
 *
 * Unlike `/api/chat` this returns plain JSON rather than SSE. There is nothing to
 * stream — the model produces one image in one shot — and a fake event stream
 * would only add a parser to the client for no benefit.
 *
 * ## What lands in the conversation
 *
 * Two rows, matching what a chat turn writes:
 *
 *   user       the prompt, as typed
 *   assistant  a short note, with the image linked via `files.message_id`
 *
 * Attaching to the *assistant* row is what makes this free on the read side:
 * `sessions.getTranscript` groups attachments by message id without caring about
 * role, so the image appears on reload with no change to the transcript path.
 *
 * The image is never fed back to the model. `gpt-5.6-sol` is `vision: false`
 * (see `models.ts`), so it could not see it — the assistant row's content is
 * text, and the image is an attachment beside it.
 */

import {
  generateImage,
  ImageError,
  resolveImageProvider,
  GENERATED_EXTENSION,
  GENERATED_MIME,
  MAX_PROMPT_CHARS,
} from '../images.ts'
import { json, notConfigured, notFound, serverError } from '../lib/http.ts'
import { readJsonBody, requireString, requireUuid } from '../lib/validate.ts'
import { batch, requireBucket } from '../db/client.ts'
import * as activity from '../db/activity.ts'
import * as filesDb from '../db/files.ts'
import * as messagesDb from '../db/messages.ts'
import * as sessionsDb from '../db/sessions.ts'
import * as ratelimit from '../lib/ratelimit.ts'
import * as suspicious from '../lib/suspicious.ts'
import { r2Key, sanitiseFilename } from '../lib/files/detect.ts'
import { newId, sha256Hex } from '../lib/hash.ts'
import type { AuthedContext } from '../auth/middleware.ts'

/** What the assistant turn says. The image beside it is the actual answer. */
const ASSISTANT_NOTE = 'Here is the image you asked for.'

interface ImageBody {
  sessionId?: string
  prompt: string
}

function parseBody(raw: Record<string, unknown>): ImageBody {
  return {
    sessionId:
      raw.sessionId === undefined || raw.sessionId === null
        ? undefined
        : requireUuid(raw.sessionId, 'sessionId'),
    // flux-1-schnell's own ceiling. Refused here rather than upstream so the
    // rejection costs nothing and says something useful.
    prompt: requireString(raw.prompt, 'prompt', { min: 1, max: MAX_PROMPT_CHARS }),
  }
}

export async function postImage(ctx: AuthedContext): Promise<Response> {
  const cfg = resolveImageProvider(ctx.env)
  if (!cfg) {
    // 503 with the same `not_configured` type the chat route uses when it has no
    // upstream: the deployment is fine, this one capability is not wired up.
    throw notConfigured(
      'Image generation is not available. It needs the `AI` binding in wrangler.jsonc ' +
        'and IMAGE_ENABLED left unset or "true".',
    )
  }

  const bucket = requireBucket(ctx.env.FILES)
  const body = parseBody(await readJsonBody(ctx.request))

  await limitImage(ctx)

  const session = await resolveSession(ctx, body, cfg.model)

  // The user turn is committed before generation, exactly as `/api/chat` commits
  // before opening its stream: a request that fails upstream should still leave a
  // record of what was asked, not a gap.
  const userMessage = messagesDb.insertStmt({
    sessionId: session.id,
    userId: ctx.user.id,
    role: 'user',
    content: body.prompt,
    model: cfg.model,
    modelProvider: 'workers-ai',
  })
  const statements = [
    userMessage.stmt,
    // `null`, not the image model: `touchStmt` COALESCEs, so passing it would
    // relabel a mixed conversation's `model_used` as the image model and leave
    // the sidebar claiming the whole chat ran on flux.
    sessionsDb.touchStmt(session.id, 1, null),
    activity.logStmt({
      userId: ctx.user.id,
      action: 'message_sent',
      // Ids and counts only — the prompt itself is user content and stays out.
      metadata: { sessionId: session.id, model: cfg.model, chars: body.prompt.length, kind: 'image' },
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
    }),
  ]

  // Name the conversation from the prompt, on the first turn only.
  //
  // The chat path gets its name from `autoTitle`, which asks a model — there is
  // no titler on this path, and no text answer to name a session after, so
  // without this an image-first conversation would sit in the sidebar as "New
  // chat" for good. `retitleStmt` already refuses to touch a `manual` title.
  if (session.title_source === 'placeholder' && session.message_count === 0) {
    statements.push(sessionsDb.retitleStmt(session.id, sessionsDb.makeTitle(body.prompt)))
  }

  await batch(ctx.db, statements)

  let bytes: Uint8Array
  try {
    bytes = await generateImage(cfg, body.prompt)
  } catch (err) {
    if (err instanceof ImageError) {
      ctx.exec.waitUntil(persistFailure(ctx, session.id, cfg.model, err.message))
      console.error('[chatddb] image generation failed (%s): %s', err.type, err.message)
    }
    throw err
  }

  const file = await store(ctx, bucket, session.id, body.prompt, cfg.model, bytes)

  // The assistant turn and the file link land together: a message claiming an
  // image with no row pointing at it would render as an empty bubble.
  const assistant = messagesDb.insertStmt({
    sessionId: session.id,
    userId: ctx.user.id,
    role: 'assistant',
    content: ASSISTANT_NOTE,
    model: cfg.model,
    modelProvider: 'workers-ai',
    attachmentCount: 1,
    finishReason: 'stop',
  })
  await batch(ctx.db, [
    assistant.stmt,
    filesDb.attachToMessageStmt([file.id], assistant.id, session.id, ctx.user.id),
    sessionsDb.touchStmt(session.id, 1, null),
    activity.logStmt({
      userId: ctx.user.id,
      action: 'image_generated',
      metadata: {
        sessionId: session.id,
        fileId: file.id,
        model: cfg.model,
        steps: cfg.steps,
        bytes: bytes.length,
      },
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
    }),
  ])

  return json(
    { sessionId: session.id, messageId: assistant.id, userMessageId: userMessage.id, file },
    201,
    ctx.request,
    ctx.env,
  )
}

/**
 * Writes the bytes, row first.
 *
 * Same ordering as `postUpload`: the `pending` row, then the R2 put, then the
 * promotion to `stored`. A crash in the middle leaves a prunable row rather than
 * an object nobody is tracking, which is the failure that costs money quietly.
 *
 * No `detectType` call: these bytes came from our own model, not a client, and
 * `generateImage` has already checked the JPEG magic number. The filename is
 * synthesised for the same reason — there is no original to preserve.
 */
async function store(
  ctx: AuthedContext,
  bucket: R2Bucket,
  sessionId: string,
  prompt: string,
  model: string,
  bytes: Uint8Array,
): Promise<filesDb.PublicFile> {
  const fileId = newId()
  const key = r2Key(ctx.user.id, fileId, GENERATED_EXTENSION)
  const filename = sanitiseFilename(`generated-${fileId.slice(0, 8)}.${GENERATED_EXTENSION}`)

  await filesDb.createGenerated(ctx.db, {
    id: fileId,
    userId: ctx.user.id,
    sessionId,
    filename,
    originalFilename: filename,
    fileType: 'image',
    mimeType: GENERATED_MIME,
    fileSize: bytes.length,
    r2Key: key,
    processingStatus: 'none',
    genPrompt: prompt.slice(0, MAX_PROMPT_CHARS),
    genModel: model,
  })

  try {
    await bucket.put(key, bytes, {
      httpMetadata: {
        contentType: GENERATED_MIME,
        contentDisposition: `attachment; filename="${filename}"`,
      },
      customMetadata: { userId: ctx.user.id, fileId, origin: 'generated' },
    })
  } catch (err) {
    await filesDb.markFailed(ctx.db, fileId)
    console.error('[chatddb] R2 put failed for generated image %s: %s', key, err)
    throw serverError('The image was generated but could not be stored.', 'storage_failed')
  }

  await filesDb.markStored(ctx.db, fileId, await sha256Hex(bytes))

  const row = await filesDb.getOwned(ctx.db, fileId, ctx.user.id)
  if (!row) throw serverError('The image was stored but could not be read back.', 'storage_inconsistent')
  return filesDb.toPublicFile(row)
}

/**
 * The per-user image budget.
 *
 * A copy of `limitChat` in shape, but on its own `'image'` action so the two
 * cannot drain each other — and much tighter, because the allowance behind it is
 * shared across every user of the deployment rather than per-key.
 */
async function limitImage(ctx: AuthedContext): Promise<void> {
  const verdict = await ratelimit.consume(ctx.db, `user:${ctx.user.id}`, 'image', [
    { kind: 'minute', max: ctx.policy.rateImagePerMin },
    { kind: 'day', max: ctx.policy.rateImagePerDay },
  ])
  if (verdict.allowed) return

  await activity.log(ctx.db, {
    userId: ctx.user.id,
    action: 'rate_limited',
    severity: 'warn',
    metadata: { action: 'image', window: verdict.kind, limit: verdict.limit, count: verdict.count },
    ipHash: ctx.ipHash,
    userAgent: ctx.userAgent,
  })
  ctx.exec.waitUntil(
    suspicious.afterRateLimit(
      { db: ctx.db, userId: ctx.user.id, ipHash: ctx.ipHash, userAgent: ctx.userAgent },
      'image',
    ),
  )
  ratelimit.enforce(verdict, 'images')
}

/** Finds the caller's session, or starts one named from the prompt. */
async function resolveSession(
  ctx: AuthedContext,
  body: ImageBody,
  model: string,
): Promise<sessionsDb.SessionRow> {
  if (body.sessionId) {
    const existing = await sessionsDb.getOwned(ctx.db, body.sessionId, ctx.user.id)
    // Same 404 for "not yours" as for "does not exist" — distinguishing them
    // would confirm another user's session id is real.
    if (!existing) throw notFound('That conversation does not exist.', 'session_not_found')
    return existing
  }

  const created = await sessionsDb.create(
    ctx.db,
    ctx.user.id,
    sessionsDb.makeTitle(body.prompt),
    model,
  )
  ctx.exec.waitUntil(
    activity.log(ctx.db, {
      userId: ctx.user.id,
      action: 'chat_started',
      metadata: { sessionId: created.id, kind: 'image' },
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
    }),
  )
  return created
}

/**
 * Records a generation that produced nothing.
 *
 * Mirrors `persistFailure` in `routes/chat.ts`: an assistant row with empty
 * content and `finish_reason='error'`, which `historyFor` filters out of future
 * context while the admin inspector can still show what happened. Without it the
 * transcript would show a prompt followed by silence.
 */
async function persistFailure(
  ctx: AuthedContext,
  sessionId: string,
  model: string,
  message: string,
): Promise<void> {
  const inserted = messagesDb.insertStmt({
    sessionId,
    userId: ctx.user.id,
    role: 'assistant',
    content: '',
    model,
    modelProvider: 'workers-ai',
    finishReason: 'error',
    error: message.slice(0, 1_000),
  })
  try {
    await batch(ctx.db, [
      inserted.stmt,
      sessionsDb.touchStmt(sessionId, 1, null),
      activity.logStmt({
        userId: ctx.user.id,
        action: 'image_failed',
        severity: 'warn',
        metadata: { sessionId, model },
        ipHash: ctx.ipHash,
        userAgent: ctx.userAgent,
      }),
    ])
  } catch (err) {
    console.error('[chatddb] failed to record image failure: %s', err)
  }
}
