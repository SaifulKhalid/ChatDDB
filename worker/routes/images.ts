/**
 * `POST /api/images` — text to image, on Workers AI with Pollinations behind it.
 *
 * The second route that spends money, and the only one whose budget is shared:
 * `/api/chat` bills per key, but the image allowance is 10,000 neurons a day for
 * the whole *account*, drained by whichever signed-in user gets there first. So
 * the per-user limits here are tight (3/min, 20/day by default) and deliberately
 * not the chat limits.
 *
 * ## Which provider answered
 *
 * `generateImage` walks a chain (see `worker/images.ts`), so the model that
 * actually drew the image is not known until it comes back. Everything written
 * *before* generation — the user turn, the session's model label — names the
 * primary, because that is what was asked; everything written *after* names what
 * answered, which is the same split `routes/chat.ts` makes between the requested
 * model and `attempt.model`. The user is told nothing either way.
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
  resolveImageProviders,
  MAX_PROMPT_CHARS,
  type GeneratedImage,
  type ImageProvider,
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

/**
 * Resolves the provider chain, or throws the 503 both entry points share.
 *
 * Exported because the `generate_image` tool in `routes/chat.ts` has to make the
 * same call: one place decides whether image generation is available at all.
 */
export function requireImageProviders(ctx: AuthedContext): ImageProvider[] {
  const providers = resolveImageProviders(ctx.env)
  if (providers.length === 0) {
    // 503 with the same `not_configured` type the chat route uses when it has no
    // upstream: the deployment is fine, this one capability is not wired up.
    throw notConfigured(
      'Image generation is not available. It needs the `AI` binding in wrangler.jsonc ' +
        'and IMAGE_ENABLED left unset or "true".',
    )
  }
  return providers
}

export async function postImage(ctx: AuthedContext): Promise<Response> {
  const providers = requireImageProviders(ctx)
  // The primary. Labels everything written *before* generation, because at this
  // point it is what was asked for — what answered is only known afterwards.
  const cfg = providers[0]

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

  let generated: { image: GeneratedImage; file: filesDb.PublicFile }
  try {
    generated = await generateAndStore(ctx, bucket, providers, session.id, body.prompt)
  } catch (err) {
    if (err instanceof ImageError) {
      // Blamed on the provider that refused last, like `persistFailure` in
      // `routes/chat.ts`: after a crossover the primary is not the whole story.
      const provider = err.provider ?? cfg.provider
      const model = err.provider === 'pollinations' ? providerModel(providers) : cfg.model
      ctx.exec.waitUntil(persistFailure(ctx, session.id, model, provider, err.message))
      console.error('[chatddb] image generation failed on %s (%s): %s', provider, err.type, err.message)
    }
    throw err
  }
  const { image, file } = generated

  // The assistant turn and the file link land together: a message claiming an
  // image with no row pointing at it would render as an empty bubble.
  const assistant = messagesDb.insertStmt({
    sessionId: session.id,
    userId: ctx.user.id,
    role: 'assistant',
    content: ASSISTANT_NOTE,
    // What actually drew it, not what was asked for — the same rule the chat
    // route follows when the backup gateway answers.
    model: image.model,
    modelProvider: image.provider,
    attachmentCount: 1,
    finishReason: 'stop',
  })
  await batch(ctx.db, [
    assistant.stmt,
    filesDb.attachToMessageStmt([file.id], assistant.id, session.id, ctx.user.id),
    sessionsDb.touchStmt(session.id, 1, null),
    activity.logStmt(
      imageGeneratedLog({
        ctx,
        sessionId: session.id,
        fileId: file.id,
        image,
        steps: cfg.provider === 'workers-ai' ? cfg.steps : undefined,
        kind: 'button',
      }),
    ),
  ])

  return json(
    { sessionId: session.id, messageId: assistant.id, userMessageId: userMessage.id, file },
    201,
    ctx.request,
    ctx.env,
  )
}

/**
 * Draws an image on the first provider that will, and stores it.
 *
 * The whole generate-and-persist path in one exported function, because there
 * are now two callers: this route's button and the `generate_image` tool in
 * `routes/chat.ts`. Anything that lived in only one of them would drift — the
 * crossover audit row being the obvious casualty, since it fires on a code path
 * nobody looks at until the allowance is already gone.
 *
 * The `image_failover` row is written here rather than by the caller for the
 * same reason `upstream_failover` is written inside the chat route's crossover
 * callback: it has to be recorded at the moment it happens, whether or not the
 * request that triggered it goes on to succeed.
 */
export async function generateAndStore(
  ctx: AuthedContext,
  bucket: R2Bucket,
  providers: ImageProvider[],
  sessionId: string,
  prompt: string,
): Promise<{ image: GeneratedImage; file: filesDb.PublicFile }> {
  const image = await generateImage(providers, prompt, (from, to, err) => {
    ctx.exec.waitUntil(
      activity.log(ctx.db, {
        userId: ctx.user.id,
        action: 'image_failover',
        severity: 'warn',
        // Same fields as the `upstream_failover` row in `routes/chat.ts`, so the
        // admin feed reads the two the same way.
        metadata: { from, to, reason: err.type, sessionId },
        ipHash: ctx.ipHash,
        userAgent: ctx.userAgent,
      }),
    )
  })

  const file = await store(ctx, bucket, sessionId, prompt, image)
  return { image, file }
}

/** The backup's `gen_model`-style label, for a failure row that blames it. */
function providerModel(providers: ImageProvider[]): string {
  const backup = providers.find((p) => p.provider === 'pollinations')
  return backup ? `pollinations/${backup.model}` : 'pollinations'
}

/**
 * The `image_generated` audit row.
 *
 * Built here so the button and the tool log an identical shape; `kind`
 * distinguishes them, which is the one thing an admin reading the feed does need
 * to tell apart. The free neuron allowance is per *account*, so these rows are
 * the only answer to "who is spending it" — and after the backup landed, also to
 * "on whose provider".
 */
export function imageGeneratedLog(input: {
  ctx: AuthedContext
  sessionId: string
  fileId: string
  image: GeneratedImage
  /** Only meaningful on the Workers AI path; omitted when the backup answered. */
  steps?: number
  kind: 'button' | 'tool'
}): activity.ActivityInput {
  return {
    userId: input.ctx.user.id,
    action: 'image_generated',
    metadata: {
      sessionId: input.sessionId,
      fileId: input.fileId,
      model: input.image.model,
      provider: input.image.provider,
      crossedOver: input.image.crossedOver,
      ...(input.steps === undefined ? {} : { steps: input.steps }),
      bytes: input.image.bytes.length,
      kind: input.kind,
    },
    ipHash: input.ctx.ipHash,
    userAgent: input.ctx.userAgent,
  }
}

/**
 * Writes the bytes, row first.
 *
 * Same ordering as `postUpload`: the `pending` row, then the R2 put, then the
 * promotion to `stored`. A crash in the middle leaves a prunable row rather than
 * an object nobody is tracking, which is the failure that costs money quietly.
 *
 * No `detectType` call: these bytes came from our own providers, not a client,
 * and `generateImage` has already sniffed the magic number and settled the MIME
 * type — which is why that comes off the `GeneratedImage` rather than a constant
 * now that a JPEG from Workers AI and a PNG from Pollinations are both possible.
 * The filename is synthesised for the same reason — there is no original to
 * preserve.
 */
async function store(
  ctx: AuthedContext,
  bucket: R2Bucket,
  sessionId: string,
  prompt: string,
  image: GeneratedImage,
): Promise<filesDb.PublicFile> {
  const fileId = newId()
  const key = r2Key(ctx.user.id, fileId, image.extension)
  const filename = sanitiseFilename(`generated-${fileId.slice(0, 8)}.${image.extension}`)

  await filesDb.createGenerated(ctx.db, {
    id: fileId,
    userId: ctx.user.id,
    sessionId,
    filename,
    originalFilename: filename,
    fileType: 'image',
    mimeType: image.mime,
    fileSize: image.bytes.length,
    r2Key: key,
    processingStatus: 'none',
    genPrompt: prompt.slice(0, MAX_PROMPT_CHARS),
    // Which provider actually drew it. `pollinations/flux` on a crossover, the
    // bare `@cf/...` id otherwise — see `GeneratedImage.model`.
    genModel: image.model,
  })

  try {
    await bucket.put(key, image.bytes, {
      httpMetadata: {
        contentType: image.mime,
        contentDisposition: `attachment; filename="${filename}"`,
      },
      customMetadata: { userId: ctx.user.id, fileId, origin: 'generated' },
    })
  } catch (err) {
    await filesDb.markFailed(ctx.db, fileId)
    console.error('[chatddb] R2 put failed for generated image %s: %s', key, err)
    throw serverError('The image was generated but could not be stored.', 'storage_failed')
  }

  await filesDb.markStored(ctx.db, fileId, await sha256Hex(image.bytes))

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
 *
 * Exported so the `generate_image` tool in `routes/chat.ts` consumes the *same*
 * counter rather than a parallel one. A generation the model decided to run is
 * not exempt from the user's budget because no human clicked a button; it is
 * additionally subject to `limitToolImage`, which is stricter.
 */
export async function limitImage(ctx: AuthedContext): Promise<void> {
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
 *
 * `provider` is the one that refused *last*, off the `ImageError` — so a row for
 * a generation that exhausted both providers names Pollinations rather than
 * implying Workers AI was the only thing tried.
 */
async function persistFailure(
  ctx: AuthedContext,
  sessionId: string,
  model: string,
  provider: string,
  message: string,
): Promise<void> {
  const inserted = messagesDb.insertStmt({
    sessionId,
    userId: ctx.user.id,
    role: 'assistant',
    content: '',
    model,
    modelProvider: provider,
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
        metadata: { sessionId, model, provider },
        ipHash: ctx.ipHash,
        userAgent: ctx.userAgent,
      }),
    ])
  } catch (err) {
    console.error('[chatddb] failed to record image failure: %s', err)
  }
}
