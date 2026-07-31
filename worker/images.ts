/**
 * Image generation on Workers AI — the third upstream, and the only one that is
 * a binding rather than a gateway.
 *
 * ## Why not AgentRouter or freemodel
 *
 * Neither can serve it. AgentRouter *has* the route — `/v1/images/generations`
 * exists, and it knows what an image model is (`gpt-5.6-sol` is refused with
 * `model gpt-5.6-sol does not support the image_gen interface`, while a genuinely
 * unknown path 404s with `Invalid URL`) — but every image model on this account's
 * tier answers `503 无可用渠道`, "no available channel": `gpt-image-1`,
 * `dall-e-2`, `dall-e-3`, `flux-pro` alike. Its `/v1/models` lists three models,
 * all text. freemodel lists four, all text. So this had to be a new provider, and
 * Workers AI is the one with a standing free allowance.
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
 * ## Why the decode looks like that
 *
 * See `decodeBase64`. It is the one piece of real CPU work on this path, and the
 * Workers Free plan gives a request 10 ms of it.
 */

import { intVar, type WorkerEnv } from './env.ts'

/** flux-1-schnell. Overridable, but nothing else is priced to fit the free tier. */
export const DEFAULT_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell'

/** The model's own cap. Anything above is rejected upstream, not clamped. */
export const MAX_STEPS = 8
/** flux-1-schnell's documented prompt ceiling. */
export const MAX_PROMPT_CHARS = 2048

/** What `flux-1-schnell` returns: a base64 JPEG, always at 1024x1024. */
export const GENERATED_MIME = 'image/jpeg'
export const GENERATED_EXTENSION = 'jpg'

/** Resolved image-generation settings, or null when the feature is off. */
export interface ImageConfig {
  ai: Ai
  model: string
  steps: number
}

/**
 * Reads the image provider out of the environment, or null when unavailable.
 *
 * Two ways to be off: no `AI` binding at all, and the `IMAGE_ENABLED` kill
 * switch. As with `FALLBACK_ENABLED`, only the exact string `'false'` disables —
 * a typo leaves the feature armed rather than silently removing it.
 */
export function resolveImageProvider(env: WorkerEnv): ImageConfig | null {
  if (!env.AI) return null
  if (env.IMAGE_ENABLED?.trim() === 'false') return null

  return {
    ai: env.AI,
    model: env.IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL,
    steps: Math.min(MAX_STEPS, Math.max(1, intVar(env.IMAGE_STEPS, 4))),
  }
}

/** True when image generation is available — reported by `/api/health`. */
export function imageReady(env: WorkerEnv): boolean {
  return resolveImageProvider(env) !== null
}

/** A generation attempt failed. Carries the status the route should reply with. */
export class ImageError extends Error {
  readonly status: number
  readonly type: string

  constructor(message: string, status: number, type: string) {
    super(message)
    this.name = 'ImageError'
    this.status = status
    this.type = type
  }
}

/**
 * Generates one image, returning JPEG bytes.
 *
 * No retry ladder, deliberately. Unlike a chat completion there is no second
 * gateway to fall back to, and every attempt spends from a shared daily
 * allowance — so a retry is just a second charge for the same probably-identical
 * failure. The user can press the button again, having been told what went wrong.
 */
export async function generateImage(cfg: ImageConfig, prompt: string): Promise<Uint8Array> {
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
    throw classify(err)
  }

  // `image` is optional in the binding's own types, so a successful call can
  // still yield nothing. Treated as a failure rather than an empty file.
  if (!output?.image) {
    throw new ImageError(
      'The image model returned no image. Try rephrasing the prompt.',
      502,
      'image_empty',
    )
  }

  const bytes = decodeBase64(output.image)
  // A JPEG starts FF D8 FF. Checked because everything downstream — the stored
  // `mime_type`, the `Content-Type` on `/api/files/view`, the `<img>` that
  // renders it — assumes this, and a silently wrong format would surface as a
  // broken thumbnail long after the cause.
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new ImageError('The image model returned data that is not a JPEG.', 502, 'image_malformed')
  }
  return bytes
}

/**
 * Turns a binding failure into something a user can act on.
 *
 * The case that matters is the daily allowance: on the Workers Free plan
 * requests simply start failing once the 10,000 neurons are gone, and "resets at
 * 00:00 UTC" is the difference between a user waiting and a user filing a bug.
 * Usage counters reset daily at 00:00 UTC.
 */
function classify(err: unknown): ImageError {
  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()

  if (lower.includes('capacity') || lower.includes('quota') || lower.includes('limit')) {
    return new ImageError(
      "The daily image allowance for this deployment is used up. It resets at 00:00 UTC.",
      429,
      'image_quota_exhausted',
    )
  }
  if (lower.includes('no such model') || lower.includes('not found') || lower.includes('invalid model')) {
    return new ImageError(
      `The configured image model is not available. Check the IMAGE_MODEL var.`,
      500,
      'image_model_unavailable',
    )
  }
  // Prompt-level refusals from the model's own safety filter.
  if (lower.includes('safety') || lower.includes('blocked') || lower.includes('nsfw')) {
    return new ImageError('That prompt was refused by the image model.', 400, 'image_prompt_refused')
  }

  console.error('[chatddb] image generation failed: %s', message)
  return new ImageError('Image generation failed. Try again.', 502, 'image_failed')
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
