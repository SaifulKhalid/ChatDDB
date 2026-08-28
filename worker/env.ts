/**
 * The Worker's environment, declared by hand.
 *
 * Not extending the generated `Env` from `wrangler types` is deliberate: that
 * generator infers secrets from whatever happens to sit in `.dev.vars`, so the
 * inferred shape differs between machines and CI. This file is the contract.
 *
 * Secrets are optional in the type because a Worker can legitimately boot
 * without them -- `/api/health` reports what is missing instead of throwing.
 */

export interface WorkerEnv {
  // ---- Bindings -----------------------------------------------------------
  /** D1 `chatddb-f5-db`. Absent only if the binding was removed. */
  DB?: D1Database
  /** R2 `chatddb-f5-storage`. */
  FILES?: R2Bucket
  /**
   * Workers AI, for `POST /api/images`.
   *
   * Optional like every other binding here: with it absent the image route
   * reports itself unconfigured and the composer hides its toggle, exactly as
   * the chat route does without an upstream key.
   */
  AI?: Ai

  // ---- Secrets (`wrangler secret put` / .dev.vars) ------------------------
  /** Primary upstream API key. */
  PROVIDER_API_KEY?: string
  /** Fallback API key 2. */
  PROVIDER_API_KEY_2?: string
  /** Fallback API key 3. */
  PROVIDER_API_KEY_3?: string
  /** Legacy alias for primary API key. */
  AGENTROUTER_API_KEY?: string
  /** Legacy alias for secondary API key. */
  AGENTROUTER_API_KEY_2?: string
  /** Legacy alias for tertiary API key. */
  AGENTROUTER_API_KEY_3?: string
  /** Salt for `ip_hash`. Rotating it deliberately breaks old correlations. */
  IP_HASH_SALT?: string
  /** HMAC key for short-lived signed file-view URLs. */
  FILE_URL_SECRET?: string
  /**
   * Pollinations API key — the backup image provider.
   */
  POLLINATIONS_API_KEY?: string

  // ---- API Provider Configuration -----------------------------------------
  API_PROVIDER_MODEL?: string
  API_PROVIDER_BASE_URL?: string
  API_PROVIDER_USER_AGENT?: string
  /** Legacy aliases */
  AGENTROUTER_MODEL?: string
  AGENTROUTER_BASE_URL?: string
  AGENTROUTER_USER_AGENT?: string
  MAX_OUTPUT_TOKENS?: string
  UPSTREAM_TIMEOUT_MS?: string
  REASONING_EFFORT?: string
  SYSTEM_PROMPT?: string

  // ---- Image generation ---------------------------------------------------
  /** Workers AI model id. Default `@cf/black-forest-labs/flux-1-schnell`. */
  IMAGE_MODEL?: string
  /** `'false'` disables image generation without removing the AI binding. */
  IMAGE_ENABLED?: string
  /** Diffusion steps, 1-8. More is slower and costs 9.6 neurons each. */
  IMAGE_STEPS?: string
  RATE_IMAGE_PER_MIN?: string
  RATE_IMAGE_PER_DAY?: string
  /**
   * Kill switch for the Pollinations backup, same convention as
   * `FALLBACK_ENABLED`: only the exact string `'false'` disarms it, so a typo
   * fails safe (armed) rather than silently removing the fallback.
   */
  POLLINATIONS_ENABLED?: string
  /** Pollinations model id. Default `flux`. */
  POLLINATIONS_MODEL?: string
  /** Default `https://gen.pollinations.ai`. */
  POLLINATIONS_BASE_URL?: string
  /**
   * Daily cap on images the *model* triggers via the `generate_image` tool.
   *
   * Separate from, and additional to, `RATE_IMAGE_PER_DAY`: a button press is a
   * human deciding to spend the shared allowance, while a tool call is the model
   * deciding. Prompting is a hint, not a budget — see `routes/chat.ts`.
   */
  RATE_TOOL_IMAGE_PER_DAY?: string

  // ---- SVG diagrams -------------------------------------------------------
  /**
   * `'false'` stops the system prompt inviting the model to draw figures.
   *
   * Same convention as the other kill switches: only the exact string disarms
   * it. Note what it does *not* turn off — the figure gate in `sse.ts` and the
   * sanitiser behind it run regardless, because a user can ask the model to
   * write SVG whatever the prompt says, and "no unsanitised markup reaches a
   * browser" is not a thing worth having an off position for.
   *
   * There is no metered budget here, unlike `IMAGE_ENABLED`: drawing costs the
   * output tokens of the reply and nothing else. The switch exists to turn the
   * behaviour off if it proves annoying, not to stop it spending anything.
   */
  SVG_DIAGRAMS?: string

  // ---- Auth ---------------------------------------------------------------
  /** Firebase project id. A public identifier, so a var and not a secret. */
  FIREBASE_PROJECT_ID?: string
  /** Comma-separated emails promoted to `admin` on login. */
  ADMIN_EMAILS?: string

  // ---- Policy -------------------------------------------------------------
  /** Comma-separated CORS allowlist. Replaces the old echo-any-origin rule. */
  ALLOWED_ORIGINS?: string
  MAX_IMAGE_BYTES?: string
  MAX_PDF_BYTES?: string
  MAX_ATTACHMENTS_PER_MESSAGE?: string
  /** `client` (Free plan, pdf.js in the browser) or `worker` (Paid, unpdf). */
  PDF_EXTRACT_MODE?: string
  PDF_MAX_PAGES?: string
  PDF_CONTEXT_CHARS?: string
  HISTORY_MAX_TURNS?: string
  RATE_CHAT_PER_MIN?: string
  RATE_CHAT_PER_DAY?: string
  RATE_UPLOAD_PER_MIN?: string
  RATE_UPLOAD_PER_DAY?: string
  RATE_AUTH_PER_MIN?: string
  RATE_ADMIN_PER_MIN?: string
  ACTIVITY_RETENTION_DAYS?: string
}

/** Parses an integer var, falling back when unset, unparseable, or negative. */
export function intVar(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** Splits a comma-separated var into trimmed, non-empty entries. */
export function listVar(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Effective policy numbers, resolved once per request from `env`. */
export interface Policy {
  maxImageBytes: number
  maxPdfBytes: number
  maxAttachmentsPerMessage: number
  pdfExtractMode: 'client' | 'worker'
  pdfMaxPages: number
  pdfContextChars: number
  historyMaxTurns: number
  rateChatPerMin: number
  rateChatPerDay: number
  rateUploadPerMin: number
  rateUploadPerDay: number
  rateAuthPerMin: number
  rateAdminPerMin: number
  rateImagePerMin: number
  rateImagePerDay: number
  rateToolImagePerDay: number
  imageSteps: number
  activityRetentionDays: number
}

export function resolvePolicy(env: WorkerEnv): Policy {
  return {
    maxImageBytes: intVar(env.MAX_IMAGE_BYTES, 10 * 1024 * 1024),
    maxPdfBytes: intVar(env.MAX_PDF_BYTES, 25 * 1024 * 1024),
    maxAttachmentsPerMessage: intVar(env.MAX_ATTACHMENTS_PER_MESSAGE, 4),
    // Anything but an explicit `worker` means client-side extraction: the Free
    // plan's 10 ms CPU ceiling cannot parse a PDF, so this fails safe.
    pdfExtractMode: env.PDF_EXTRACT_MODE?.trim() === 'worker' ? 'worker' : 'client',
    pdfMaxPages: intVar(env.PDF_MAX_PAGES, 50),
    pdfContextChars: intVar(env.PDF_CONTEXT_CHARS, 24_000),
    historyMaxTurns: intVar(env.HISTORY_MAX_TURNS, 30),
    rateChatPerMin: intVar(env.RATE_CHAT_PER_MIN, 20),
    rateChatPerDay: intVar(env.RATE_CHAT_PER_DAY, 300),
    rateUploadPerMin: intVar(env.RATE_UPLOAD_PER_MIN, 10),
    rateUploadPerDay: intVar(env.RATE_UPLOAD_PER_DAY, 100),
    rateAuthPerMin: intVar(env.RATE_AUTH_PER_MIN, 30),
    rateAdminPerMin: intVar(env.RATE_ADMIN_PER_MIN, 120),
    rateImagePerMin: intVar(env.RATE_IMAGE_PER_MIN, 3),
    rateImagePerDay: intVar(env.RATE_IMAGE_PER_DAY, 20),
    // Deliberately a quarter of the button's daily budget. The tool fires on the
    // model's judgement, and a model that decides to illustrate more often than
    // intended should run out of its own allowance long before it can drain the
    // one a human is queuing behind.
    rateToolImagePerDay: intVar(env.RATE_TOOL_IMAGE_PER_DAY, 5),
    // Clamped, not just defaulted: flux-1-schnell rejects anything outside 1-8,
    // and a misconfigured var should cost a worse image, not every request.
    imageSteps: Math.min(8, Math.max(1, intVar(env.IMAGE_STEPS, 4))),
    activityRetentionDays: intVar(env.ACTIVITY_RETENTION_DAYS, 90),
  }
}
