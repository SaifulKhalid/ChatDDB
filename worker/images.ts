/**
 * Image generation, on two providers: Workers AI first, Pollinations behind it.
 *
 * ## Dedicated Image Providers
 *
 * Workers AI is used as the primary image provider with standing free allowance,
 * with Pollinations configured as fallback.
 *
 * ## Why flux-1-schnell specifically
 *
 * Price, by two orders of magnitude. It bills 4.80 neurons per 512x512 tile plus
 * 9.60 per step, so a 1024x1024 four-step image costs ~57.6 neurons against the
 * 10,000/day free allocation — roughly 173 images a day. `lucid-origin`, the next
 * model up, bills 636 neurons per tile: about four images a day on the same
 * allowance. That allowance is per *account* and shared by every signed-in user,
 * which is what the per-user limits in `routes/images.ts` are defending.
 *
 * ## The second provider, and why the crossover is narrow
 *
 * This file used to say there was no retry ladder because "there is no second
 * gateway to fall back to". There is one now. Pollinations sits behind Workers AI
 * exactly as backup providers sit behind the primary in `failover.ts`, and for the
 * same reason: the allowance in front is a hard daily wall shared by every user,
 * so the first person to spend it used to take image generation down for
 * everybody until 00:00 UTC.
 *
 * The crossover is deliberately scoped to **`image_quota_exhausted` and
 * `image_model_unavailable`** — the two classes that mean *this provider cannot
 * serve right now*, which is the only claim a different provider can disprove.
 *
 * `image_prompt_refused` is pointedly excluded. A prompt that one model's safety
 * filter rejected must not be quietly resubmitted to a model with a different
 * policy: that turns a refusal into a retry loop for finding the laxest filter on
 * the chain, and it means the deployment's effective content policy is whichever
 * provider happens to be last. A refusal is an answer, and it stops the chain.
 *
 * `image_failed`, `image_empty` and `image_malformed` do not cross either. They
 * say something unexpected happened, not that this provider is unavailable, and
 * every attempt spends real budget.
 *
 * ## Two providers, two error vocabularies
 *
 * `classifyWorkersAi` and `classifyPollinations` are separate functions on
 * purpose. Workers AI throws `Error`s whose wording is its own ("capacity",
 * "quota"); Pollinations answers with an HTTP status and a JSON envelope
 * (`{success, error: {message, code}, status}`) that shares none of that
 * vocabulary — see the note on `classifyPollinations` for what it actually
 * returns, which is not what you would guess. Both funnel into the same four
 * `ImageError` types so the route, the chain, and the user-facing status codes
 * do not have to care which provider answered.
 *
 * ## Why the decode looks like that
 *
 * See `decodeBase64`. It is the one piece of real CPU work on the Workers AI
 * path, and the Workers Free plan gives a request 10 ms of it. The Pollinations
 * path has no equivalent: it answers with image bytes directly.
 */

import { intVar, type WorkerEnv } from './env.ts'
import { ApiError } from './lib/http.ts'

/** flux-1-schnell. Overridable, but nothing else is priced to fit the free tier. */
export const DEFAULT_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell'

/** The model's own cap. Anything above is rejected upstream, not clamped. */
export const MAX_STEPS = 8
/**
 * flux-1-schnell's documented prompt ceiling.
 *
 * It bounds the Pollinations path too, where the prompt is a *path segment*
 * rather than a body field. 2048 characters percent-encode to at most ~6 KB,
 * comfortably inside the 16 KB URL that Workers and Cloudflare's edge accept —
 * so the tighter model limit is the only one that ever bites.
 */
export const MAX_PROMPT_CHARS = 2048

/** Pollinations' default model. `turbo` was retired; `flux` is what is live. */
export const DEFAULT_POLLINATIONS_MODEL = 'flux'
export const DEFAULT_POLLINATIONS_BASE_URL = 'https://gen.pollinations.ai'
/**
 * Matches flux-1-schnell's fixed 1024x1024 output, so a crossover changes which
 * provider drew the image and not what shape it comes back.
 */
export const POLLINATIONS_SIZE = 1024
/**
 * Shorter than a patient timeout on purpose, same reasoning as
 * `FALLBACK_TIMEOUT_MS` in `failover.ts`: by the time the backup is asked, the
 * user has already waited out whatever the primary wasted before failing. There
 * is no client signal plumbed through this path — the `ai` binding takes none
 * either — so this is the only thing bounding a hung backup.
 */
export const POLLINATIONS_TIMEOUT_MS = 60_000

/** Which provider drew an image. Labels logs, activity rows, and `gen_model`. */
export type ImageProviderId = 'workers-ai' | 'pollinations'

/** Resolved Workers AI settings — the primary. */
export interface ImageConfig {
  provider: 'workers-ai'
  ai: Ai
  model: string
  steps: number
}

/** Resolved Pollinations settings — the backup. */
export interface PollinationsConfig {
  provider: 'pollinations'
  apiKey: string
  baseUrl: string
  model: string
}

export type ImageProvider = ImageConfig | PollinationsConfig

/** One generated image, and the provenance the caller has to record. */
export interface GeneratedImage {
  bytes: Uint8Array
  /** Sniffed from the bytes, never from the provider's `Content-Type` header. */
  mime: string
  extension: string
  provider: ImageProviderId
  /**
   * What lands in `files.gen_model`.
   *
   * Workers AI keeps its bare model id (`@cf/black-forest-labs/flux-1-schnell`),
   * which already names its provider unambiguously and matches every row written
   * before the backup existed. Pollinations is prefixed (`pollinations/flux`)
   * because `flux` on its own would be indistinguishable from the Cloudflare
   * model of the same family.
   */
  model: string
  /** True when the primary failed first — drives the audit row. */
  crossedOver: boolean
}

/**
 * Reads the primary image provider out of the environment, or null when
 * unavailable.
 *
 * Two ways to be off: no `AI` binding at all, and the `IMAGE_ENABLED` kill
 * switch. As with `FALLBACK_ENABLED`, only the exact string `'false'` disables —
 * a typo leaves the feature armed rather than silently removing it.
 */
export function resolveImageProvider(env: WorkerEnv): ImageConfig | null {
  if (!env.AI) return null
  if (env.IMAGE_ENABLED?.trim() === 'false') return null

  return {
    provider: 'workers-ai',
    ai: env.AI,
    model: env.IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL,
    steps: Math.min(MAX_STEPS, Math.max(1, intVar(env.IMAGE_STEPS, 4))),
  }
}

/**
 * The Pollinations config, or null when it is unset or switched off.
 *
 * Shaped like `resolveFallback` in `failover.ts`, including the kill switch that
 * only the exact string `'false'` trips. The key is a secret and never a var:
 * Pollinations meters by account, so a key in `wrangler.jsonc` would be a
 * spendable credential in git history.
 */
export function resolvePollinations(env: WorkerEnv): PollinationsConfig | null {
  const apiKey = env.POLLINATIONS_API_KEY?.trim()
  if (!apiKey || apiKey === 'pk-replace-me') return null
  if (env.POLLINATIONS_ENABLED?.trim() === 'false') return null

  return {
    provider: 'pollinations',
    apiKey,
    baseUrl: (env.POLLINATIONS_BASE_URL?.trim() || DEFAULT_POLLINATIONS_BASE_URL).replace(/\/+$/, ''),
    model: env.POLLINATIONS_MODEL?.trim() || DEFAULT_POLLINATIONS_MODEL,
  }
}

/**
 * Builds the provider chain: Workers AI first, Pollinations second.
 *
 * Returns `[]` — not a Pollinations-only chain — when the primary is absent or
 * switched off, which is the same rule `resolveProviders` follows for chat: the
 * backup does not substitute for a missing primary. Two reasons here. Pollinations
 * is metered, so a deployment running entirely on it would be spending money
 * nobody chose to spend; and `IMAGE_ENABLED` is the *feature's* kill switch, so
 * turning it off has to turn the feature off rather than reroute it.
 */
export function resolveImageProviders(env: WorkerEnv): ImageProvider[] {
  const primary = resolveImageProvider(env)
  if (!primary) return []

  const backup = resolvePollinations(env)
  return backup ? [primary, backup] : [primary]
}

/** True when image generation is available at all — reported by `/api/health`. */
export function imageReady(env: WorkerEnv): boolean {
  return resolveImageProvider(env) !== null
}

/** True when a backup image provider is armed — reported by `/api/health`. */
export function imageFallbackReady(env: WorkerEnv): boolean {
  return resolveImageProvider(env) !== null && resolvePollinations(env) !== null
}

/**
 * A generation attempt failed. Carries the status the route should reply with.
 *
 * **It extends `ApiError`, and that is load-bearing.** `errorResponse` renders
 * an `ApiError` and nothing else: every other thrown value becomes a flat
 * `500 internal_error` with the message replaced by "Something went wrong on our
 * side.". As a plain `Error` this class spent its whole existence building
 * statuses and types — `429 image_quota_exhausted`, `400 image_prompt_refused` —
 * that the client never saw, because they were discarded at the boundary. The
 * argument order is kept as it was so no call site has to change.
 */
export class ImageError extends ApiError {
  /**
   * Which provider refused, when one did.
   *
   * Undefined only for a chain-level failure with no provider to blame. The
   * route records it so a failure row after a crossover names the provider that
   * refused *last*, rather than implying the primary was the only thing tried —
   * the same rule `persistFailure` in `routes/chat.ts` follows for gateways.
   */
  readonly provider: ImageProviderId | undefined

  constructor(message: string, status: number, type: string, provider?: ImageProviderId) {
    super(status, type, message)
    this.name = 'ImageError'
    this.provider = provider
  }
}

/**
 * The error classes that justify asking a different provider.
 *
 * Both mean "this provider cannot serve this request right now", which is the
 * only claim another provider is in a position to disprove. Everything else —
 * refusals especially — stops the chain. See the header for why.
 */
const CROSSABLE_TYPES = new Set(['image_quota_exhausted', 'image_model_unavailable'])

/** Called once per crossover, before the backup is tried. */
export type ImageCrossoverReporter = (
  from: ImageProviderId,
  to: ImageProviderId,
  err: ImageError,
) => void

/**
 * Generates one image on the first provider that will produce one.
 *
 * The shape is `completeWithFailover`'s, minus the streaming concerns it exists
 * to protect: an image is one indivisible result, so there is no "already
 * delivered bytes" invariant to preserve and the loop can live here rather than
 * being pushed above a stream opener.
 *
 * Non-crossable failures throw immediately rather than after trying everything,
 * because each attempt spends real budget on a provider that was never asked a
 * question it could answer differently.
 */
export async function generateImage(
  providers: ImageProvider[],
  prompt: string,
  onCrossover?: ImageCrossoverReporter,
): Promise<GeneratedImage> {
  if (providers.length === 0) {
    throw new ImageError('No image provider is configured.', 503, 'image_not_configured')
  }

  for (let i = 0; i < providers.length; i++) {
    const cfg = providers[i]
    const next = providers[i + 1]

    try {
      const image = await runProvider(cfg, prompt)
      if (i > 0) {
        console.warn('[image-failover] %s answered after %s failed', cfg.provider, providers[0].provider)
      }
      return { ...image, crossedOver: i > 0 }
    } catch (err) {
      if (!next) throw err
      if (!(err instanceof ImageError) || !CROSSABLE_TYPES.has(err.type)) throw err

      console.warn(
        '[image-failover] %s -> %s (%s): %s',
        cfg.provider, next.provider, err.type, err.message,
      )
      onCrossover?.(cfg.provider, next.provider, err)
    }
  }

  // Unreachable: the final iteration either returns or throws.
  throw new ImageError('No image provider is configured.', 503, 'image_not_configured')
}

function runProvider(cfg: ImageProvider, prompt: string): Promise<Omit<GeneratedImage, 'crossedOver'>> {
  return cfg.provider === 'workers-ai' ? runWorkersAi(cfg, prompt) : runPollinations(cfg, prompt)
}

/** Workers AI: a binding call returning base64, which then has to be decoded. */
async function runWorkersAi(
  cfg: ImageConfig,
  prompt: string,
): Promise<Omit<GeneratedImage, 'crossedOver'>> {
  let output: { image?: string }
  try {
    output = (await cfg.ai.run(
      // The model id is a plain string from config, but `run()` is typed to a
      // union of known model names. The cast is the price of keeping the model
      // configurable; an unknown id fails at runtime with a clear message below.
      cfg.model as Parameters<Ai['run']>[0],
      { prompt, steps: cfg.steps },
    )) as { image?: string }
  } catch (err) {
    throw classifyWorkersAi(err)
  }

  // `image` is optional in the binding's own types, so a successful call can
  // still yield nothing. Treated as a failure rather than an empty file.
  if (!output?.image) {
    throw new ImageError(
      'The image model returned no image. Try rephrasing the prompt.',
      502,
      'image_empty',
      'workers-ai',
    )
  }

  const bytes = decodeBase64(output.image)
  return { ...sniff(bytes, 'workers-ai'), bytes, provider: 'workers-ai', model: cfg.model }
}

/**
 * Pollinations: a plain `GET` whose body *is* the image.
 *
 * No base64 anywhere on this path — the response carries JPEG or PNG bytes
 * directly, which is why `decodeBase64` and its 10 ms CPU note apply only to the
 * primary. A non-2xx, or a 2xx that is not actually an image, goes to
 * `classifyPollinations`.
 */
async function runPollinations(
  cfg: PollinationsConfig,
  prompt: string,
): Promise<Omit<GeneratedImage, 'crossedOver'>> {
  const url =
    `${cfg.baseUrl}/image/${encodeURIComponent(prompt)}` +
    `?model=${encodeURIComponent(cfg.model)}&width=${POLLINATIONS_SIZE}&height=${POLLINATIONS_SIZE}`

  let res: Response
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(POLLINATIONS_TIMEOUT_MS),
    })
  } catch (err) {
    // Unreachable or timed out. Classed as unavailable rather than as a generic
    // failure so the wording matches what actually happened; it is the last
    // provider on the chain either way, so nothing crosses over from here.
    throw new ImageError(
      `The backup image provider could not be reached: ${err instanceof Error ? err.message : String(err)}`,
      500,
      'image_model_unavailable',
      'pollinations',
    )
  }

  if (!res.ok) throw await classifyPollinations(res)

  // A 200 that is not an image is still a failure. Pollinations answers errors
  // with `application/json`, so this catches an error envelope that arrived with
  // an optimistic status rather than storing the JSON as if it were a picture.
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.startsWith('image/')) throw await classifyPollinations(res)

  const bytes = new Uint8Array(await res.arrayBuffer())
  return {
    ...sniff(bytes, 'pollinations'),
    bytes,
    provider: 'pollinations',
    model: `pollinations/${cfg.model}`,
  }
}

/** Magic-byte signatures for the two formats a generator can hand back. */
const IMAGE_SIGNATURES: { pattern: number[]; mime: string; extension: string }[] = [
  { pattern: [0xff, 0xd8, 0xff], mime: 'image/jpeg', extension: 'jpg' },
  { pattern: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png', extension: 'png' },
]

/**
 * Identifies the bytes, or refuses them.
 *
 * Checked because everything downstream — the stored `mime_type`, the
 * `Content-Type` on `/api/files/view`, the `<img>` that renders it — trusts this
 * answer, and a silently wrong format surfaces as a broken thumbnail long after
 * the cause. It reads the bytes rather than the provider's `Content-Type` header
 * for the same reason `detectType` does it for uploads: the header is a claim.
 *
 * `detectType` itself is not reused here. It cross-checks against a filename
 * extension and throws `badRequest` — both right for a client upload and wrong
 * for bytes we generated ourselves, where there is no filename yet and the
 * failure is a 502 about the provider rather than a 400 about the user.
 *
 * Workers AI's flux-1-schnell has only ever returned JPEG; PNG is here because
 * Pollinations picks per model and is documented to serve either.
 */
function sniff(bytes: Uint8Array, provider: ImageProviderId): { mime: string; extension: string } {
  const found = IMAGE_SIGNATURES.find(
    (sig) => bytes.length >= sig.pattern.length && sig.pattern.every((b, i) => bytes[i] === b),
  )
  if (!found) {
    throw new ImageError(
      `The ${provider === 'workers-ai' ? 'image model' : 'backup image provider'} returned data that is not a JPEG or PNG.`,
      502,
      'image_malformed',
      provider,
    )
  }
  return { mime: found.mime, extension: found.extension }
}

/**
 * Turns a Workers AI binding failure into something a user can act on.
 *
 * The case that matters is the daily allowance: on the Workers Free plan
 * requests simply start failing once the 10,000 neurons are gone, and "resets at
 * 00:00 UTC" is the difference between a user waiting and a user filing a bug.
 * Usage counters reset daily at 00:00 UTC.
 *
 * With the backup armed, the first two branches are also what *arms the
 * crossover* — they are the two types in `CROSSABLE_TYPES` — so the wording here
 * is often something no user ever reads, because Pollinations answered instead.
 */
function classifyWorkersAi(err: unknown): ImageError {
  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()

  if (lower.includes('capacity') || lower.includes('quota') || lower.includes('limit')) {
    return new ImageError(
      "The daily image allowance for this deployment is used up. It resets at 00:00 UTC.",
      429,
      'image_quota_exhausted',
      'workers-ai',
    )
  }
  if (lower.includes('no such model') || lower.includes('not found') || lower.includes('invalid model')) {
    return new ImageError(
      `The configured image model is not available. Check the IMAGE_MODEL var.`,
      500,
      'image_model_unavailable',
      'workers-ai',
    )
  }
  // Prompt-level refusals from the model's own safety filter. Deliberately not
  // crossable: see the header.
  if (lower.includes('safety') || lower.includes('blocked') || lower.includes('nsfw')) {
    return new ImageError(
      'That prompt was refused by the image model.',
      400,
      'image_prompt_refused',
      'workers-ai',
    )
  }

  console.error('[chatddb] image generation failed: %s', message)
  return new ImageError('Image generation failed. Try again.', 502, 'image_failed', 'workers-ai')
}

/** Pollinations' error envelope: `{success, error: {message, code}, status}`. */
interface PollinationsError {
  success?: boolean
  error?: { message?: unknown; code?: unknown }
  status?: unknown
}

/**
 * Turns a Pollinations HTTP failure into the same four `ImageError` types.
 *
 * **Do not assume the Workers AI substrings match here — they do not.** Measured
 * against the live endpoint:
 *
 * - An unknown model is `400` / `BAD_REQUEST` with
 *   `Invalid model or alias: "turbo". Must be a valid model name or alias.`
 *   Note "invalid model" happens to appear; "no such model" never does.
 * - **Exceeding the request pace answers `401` / `UNAUTHORIZED` with
 *   `Authentication required. Please provide an API key ...`** — not `429`, and
 *   not a word about rate limits. An unrecognised bearer token is *not* rejected;
 *   it is silently treated as anonymous, so a stale key and a spent allowance
 *   produce the identical response. That is why the 401 branch below says both
 *   things: there is no way to tell them apart from the wire, and claiming
 *   either one alone would send an operator hunting in the wrong place.
 * - Nothing in its documentation specifies statuses at all, so the 5xx and
 *   content-policy branches are written from the shape of the envelope rather
 *   than from an observed response. They are deliberately last and deliberately
 *   broad; an unrecognised failure still lands on `image_failed`.
 *
 * Reads the body destructively — the caller has already decided this response is
 * not an image.
 */
async function classifyPollinations(res: Response): Promise<ImageError> {
  let body = ''
  try {
    body = await res.text()
  } catch {
    /* body already gone */
  }

  let code = ''
  let detail = ''
  try {
    const parsed = JSON.parse(body) as PollinationsError
    code = String(parsed.error?.code ?? '').toUpperCase()
    detail = String(parsed.error?.message ?? '')
  } catch {
    // Non-JSON is an edge page, not the API. The status still classifies it.
    detail = body.slice(0, 200)
  }
  const lower = `${code} ${detail}`.toLowerCase()

  // Refusals first: a content-policy 400 must not be read as "unknown model"
  // and become crossable. Nothing downstream can undo that ordering mistake.
  if (
    lower.includes('nsfw') ||
    lower.includes('safety') ||
    lower.includes('content policy') ||
    lower.includes('content_policy') ||
    lower.includes('moderation') ||
    lower.includes('inappropriate') ||
    lower.includes('prohibited')
  ) {
    return new ImageError(
      'That prompt was refused by the image provider.',
      400,
      'image_prompt_refused',
      'pollinations',
    )
  }

  // The throttle-shaped answers. 401 is in here rather than under "bad key"
  // because Pollinations answers an over-pace request with it — see above.
  if (
    res.status === 429 ||
    res.status === 401 ||
    res.status === 403 ||
    res.status === 402 ||
    code === 'UNAUTHORIZED' ||
    code === 'RATE_LIMIT' ||
    code === 'RATE_LIMITED' ||
    code === 'PAYMENT_REQUIRED' ||
    lower.includes('rate limit') ||
    lower.includes('quota') ||
    lower.includes('credit') ||
    lower.includes('pollen')
  ) {
    return new ImageError(
      'The backup image provider is out of allowance, or its API key was not accepted. ' +
        'Check POLLINATIONS_API_KEY, or try again shortly.',
      429,
      'image_quota_exhausted',
      'pollinations',
    )
  }

  // An unusable model, whether we named one it does not have or it withdrew one.
  if (
    lower.includes('invalid model') ||
    lower.includes('model or alias') ||
    lower.includes('no such model') ||
    lower.includes('unknown model') ||
    (res.status === 400 && lower.includes('model'))
  ) {
    return new ImageError(
      'The configured backup image model is not available. Check the POLLINATIONS_MODEL var.',
      500,
      'image_model_unavailable',
      'pollinations',
    )
  }

  // The provider itself is unwell. Same type as an unusable model because it
  // makes the same claim — this provider cannot serve right now — and it is the
  // claim `CROSSABLE_TYPES` is about.
  if (res.status >= 500 || lower.includes('capacity') || lower.includes('overload') || lower.includes('timeout')) {
    return new ImageError(
      'The backup image provider is unavailable right now. Try again shortly.',
      500,
      'image_model_unavailable',
      'pollinations',
    )
  }

  console.error('[chatddb] pollinations image generation failed (HTTP %d %s): %s', res.status, code, detail)
  return new ImageError('Image generation failed. Try again.', 502, 'image_failed', 'pollinations')
}

/**
 * Base64 to bytes, on the Free plan's 10 ms CPU budget.
 *
 * The obvious `Uint8Array.from(atob(s), c => c.charCodeAt(0))` is the trap here:
 * measured on a 150 KB JPEG (~200 KB of base64) it runs a **median of 9.75 ms and
 * peaks at 13.2 ms**, because it invokes a JS callback once per byte. The indexed
 * loop below does the same work in **0.33 ms** — a 30x margin. Do not "simplify"
 * this back into the callback form.
 *
 * `Uint8Array.fromBase64` is the TC39 native decoder; it is preferred when the
 * runtime has it and feature-detected because workerd's support depends on the
 * compatibility date.
 */
export function decodeBase64(b64: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64
  if (typeof native === 'function') return native(b64)

  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
