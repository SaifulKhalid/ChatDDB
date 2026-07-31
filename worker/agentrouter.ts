/**
 * The OpenAI-compatible upstream client.
 *
 * Despite the filename this is not AgentRouter-specific any more: it speaks
 * plain `/v1/chat/completions` to whichever gateway a `UpstreamConfig` points
 * at. Two are configured — AgentRouter as primary and freemodel.dev as the
 * silent fallback — and `failover.ts` builds both configs and picks between
 * them. Everything a gateway can disagree about lives in the config, so no
 * function here branches on `provider`; that field exists to label logs and to
 * record which gateway actually answered.
 *
 * One non-obvious requirement, and the reason `userAgent` is optional:
 * AgentRouter's edge runs a client whitelist. A request carrying an ordinary
 * User-Agent is rejected before it reaches the router with
 *
 *   {"error":{"message":"unauthorized client detected, ..."},
 *    "type":"unauthorized_client_error"}
 *
 * while the same request with a `claude-cli/<version> (external, ...)`
 * User-Agent is accepted (a bad key then fails with `new_api_error` instead,
 * which is how you can tell the two failures apart). The UA is therefore
 * mandatory for AgentRouter, and is exposed as `AGENTROUTER_USER_AGENT` so it
 * can be changed without a redeploy if the accepted pattern ever moves.
 * freemodel has no such whitelist and sets no `userAgent` at all.
 */

export const DEFAULT_BASE_URL = 'https://agentrouter.org/v1'
export const DEFAULT_MODEL = 'gpt-5.6-sol'
export const DEFAULT_USER_AGENT = 'claude-cli/2.1.158 (external, sdk-cli)'
export const DEFAULT_TIMEOUT_MS = 180_000

/** Which gateway a config points at. Labels logs and `chat_messages.model_provider`. */
export type ProviderId = 'agentrouter' | 'freemodel'

export type ChatRole = 'system' | 'user' | 'assistant'

/**
 * A multimodal content part, in OpenAI's shape.
 *
 * Only used when a turn actually carries an image. A text-only turn keeps
 * `content` as a plain string, because that is the form AgentRouter is known to
 * accept — see the note on `vision` in `models.ts`.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

export interface ChatMessage {
  role: ChatRole
  content: string | ContentPart[]
}

export interface UpstreamConfig {
  /** Which gateway this is. Never branched on — only logged and recorded. */
  provider: ProviderId
  /** One or more API keys. Tried in order; the next is used when one fails. */
  apiKeys: string[]
  baseUrl: string
  model: string
  /** Omitted entirely when unset, for gateways with no client whitelist. */
  userAgent?: string
  /** The token cap parameter this gateway takes; omitted when 0. */
  tokenParam: 'max_completion_tokens' | 'max_tokens'
  maxOutputTokens: number
  /** `minimal` | `low` | `medium` | `high`, omitted when unset. */
  reasoningEffort?: string
  /** False for a gateway that rejects the whole request over `reasoning_effort`. */
  sendReasoningEffort: boolean
  /** Applies to time-to-first-byte only, never to an in-flight stream. */
  timeoutMs: number
}

/** Pre-failover name, kept so existing imports read naturally. */
export type AgentRouterConfig = UpstreamConfig

/** The API key is missing, so the backend cannot serve completions. */
export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotConfiguredError'
  }
}

/** A gateway (or the provider behind it) returned a failure. */
export class UpstreamError extends Error {
  /** Status the Worker should reply with — never 404/502/503. */
  readonly status: number
  readonly upstreamStatus: number | undefined
  readonly type: string
  /**
   * Whether trying a *different gateway* could plausibly succeed.
   *
   * False for a request we malformed: another gateway would reject the same
   * body, so crossing over would only spend money on a second refusal.
   */
  readonly crossable: boolean

  constructor(
    message: string,
    status: number,
    upstreamStatus: number | undefined,
    type: string,
    crossable = true,
  ) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
    this.upstreamStatus = upstreamStatus
    this.type = type
    this.crossable = crossable
  }
}

interface EnvLike {
  AGENTROUTER_API_KEY?: string
  AGENTROUTER_API_KEY_2?: string
  AGENTROUTER_API_KEY_3?: string
  AGENTROUTER_BASE_URL?: string
  AGENTROUTER_MODEL?: string
  AGENTROUTER_USER_AGENT?: string
  MAX_OUTPUT_TOKENS?: string
  REASONING_EFFORT?: string
  UPSTREAM_TIMEOUT_MS?: string
}

function intVar(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function collectApiKeys(env: EnvLike): string[] {
  const keys: string[] = []
  for (const raw of [env.AGENTROUTER_API_KEY, env.AGENTROUTER_API_KEY_2, env.AGENTROUTER_API_KEY_3]) {
    const trimmed = raw?.trim()
    if (trimmed && trimmed !== 'sk-replace-me') keys.push(trimmed)
  }
  return keys
}

export function resolveConfig(env: EnvLike): UpstreamConfig {
  const apiKeys = collectApiKeys(env)
  if (apiKeys.length === 0) {
    throw new NotConfiguredError(
      'No AGENTROUTER_API_KEY is set. Locally: copy .dev.vars.example to ' +
        '.dev.vars and paste your key(s). Deployed: npx wrangler secret put AGENTROUTER_API_KEY (and optionally AGENTROUTER_API_KEY_2, AGENTROUTER_API_KEY_3).',
    )
  }
  return {
    provider: 'agentrouter',
    apiKeys,
    baseUrl: (env.AGENTROUTER_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: env.AGENTROUTER_MODEL?.trim() || DEFAULT_MODEL,
    userAgent: env.AGENTROUTER_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    // GPT-5.6 is a reasoning model: it takes `max_completion_tokens`.
    tokenParam: 'max_completion_tokens',
    maxOutputTokens: intVar(env.MAX_OUTPUT_TOKENS, 8192),
    reasoningEffort: env.REASONING_EFFORT?.trim() || undefined,
    sendReasoningEffort: true,
    timeoutMs: intVar(env.UPSTREAM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  }
}

export function upstreamHeaders(cfg: UpstreamConfig, apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    // Only for a gateway that whitelists clients — see the note at the top.
    ...(cfg.userAgent ? { 'User-Agent': cfg.userAgent, 'X-App': 'cli' } : {}),
  }
}

function buildBody(cfg: UpstreamConfig, messages: ChatMessage[]): string {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    stream: true,
    // Ask for token counts on the final chunk. Not every gateway honours this,
    // which is why `chat_messages.token_source` records whether a number came
    // from upstream or from our own estimate.
    stream_options: { include_usage: true },
  }
  // A reasoning model rejects a non-default `temperature`, so no sampling
  // params are sent to anyone — the cap parameter itself is per-gateway.
  if (cfg.maxOutputTokens > 0) body[cfg.tokenParam] = cfg.maxOutputTokens
  if (cfg.reasoningEffort && cfg.sendReasoningEffort) body.reasoning_effort = cfg.reasoningEffort
  return JSON.stringify(body)
}

/**
 * Waiting actually helps. The gateway is up and answering; we are going too
 * fast, or one request hiccuped. Retry the same key after a backoff.
 */
const RETRY_IN_PLACE = new Set([408, 429])
/**
 * The gateway itself is unwell. A second key on the same gateway will hit the
 * same sick edge, so when a backup gateway exists these abandon this one
 * immediately — that is what "cross over fast" means. With no backup
 * configured they fall back to the old in-place ladder, because retrying a bad
 * minute is then the only move left.
 */
const CROSS_NOW = new Set([500, 502, 503, 504, 522, 524])
const MAX_ATTEMPTS = 3

export interface CompletionOptions {
  /**
   * True when a *different* gateway is standing by to take over.
   *
   * It changes how patient this function is, not what it accepts: a
   * provider-wide failure throws on first sight instead of spending the
   * 3-attempts-per-key ladder, so `failover.ts` can cross over while the user
   * is still waiting on the first token. Per-key failures (401/403) still walk
   * the key list first — one revoked key of three is not an outage, and the
   * backup gateway is metered.
   */
  crossFast?: boolean
}

/**
 * Opens a streaming chat completion. Resolves once upstream headers are in,
 * so the returned Response body is still being produced.
 *
 * Retries only happen before any bytes are delivered — a stream that dies
 * mid-flight is surfaced to the caller rather than silently restarted, which
 * would duplicate text the user has already seen. The same reasoning is why
 * cross-provider failover lives in `failover.ts`, above this call, rather than
 * anywhere downstream of it.
 */
export async function createChatCompletion(
  cfg: UpstreamConfig,
  messages: ChatMessage[],
  clientSignal: AbortSignal,
  options: CompletionOptions = {},
): Promise<Response> {
  const crossFast = options.crossFast ?? false
  const url = `${cfg.baseUrl}/chat/completions`
  const body = buildBody(cfg, messages)
  let lastError: unknown

  for (let keyIndex = 0; keyIndex < cfg.apiKeys.length; keyIndex++) {
    const apiKey = cfg.apiKeys[keyIndex]

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (clientSignal.aborted) throw new DOMException('Aborted', 'AbortError')

      // One controller per attempt: it carries the pre-headers timeout *and*
      // forwards client aborts for the whole lifetime of the stream.
      const controller = new AbortController()
      const onClientAbort = () => controller.abort()
      clientSignal.addEventListener('abort', onClientAbort, { once: true })
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)

      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: upstreamHeaders(cfg, apiKey),
          body,
          signal: controller.signal,
        })
      } catch (err) {
        clearTimeout(timer)
        clientSignal.removeEventListener('abort', onClientAbort)
        if (clientSignal.aborted) throw new DOMException('Aborted', 'AbortError')
        lastError = err
        // Unreachable is as provider-wide as it gets: the request never landed,
        // so no key and no amount of waiting changes the answer.
        if (crossFast) {
          throw new UpstreamError(
            `Could not reach ${label(cfg)}: ${describe(err)}`,
            500,
            undefined,
            'upstream_unreachable',
          )
        }
        if (attempt < MAX_ATTEMPTS) {
          await backoff(attempt, clientSignal)
          continue
        }
        // Exhausted retries for this key — try the next key if available.
        if (keyIndex < cfg.apiKeys.length - 1) {
          console.warn(
            '[%s] key %d/%d unreachable after %d attempts, falling back to next key: %s',
            cfg.provider, keyIndex + 1, cfg.apiKeys.length, MAX_ATTEMPTS, describe(err),
          )
          break
        }
        throw new UpstreamError(
          `Could not reach ${label(cfg)}: ${describe(err)}`,
          500,
          undefined,
          'upstream_unreachable',
        )
      }

      // Headers are in — the timeout has done its job; the abort forwarder stays
      // wired so Stop in the UI also cancels the upstream generation.
      clearTimeout(timer)

      if (res.ok && res.body) {
        // Deliberately leave the abort forwarder attached: the client hanging up
        // (Stop button, closed tab) must cancel the upstream generation too.
        return res
      }

      if (res.ok && !res.body) {
        clientSignal.removeEventListener('abort', onClientAbort)
        throw new UpstreamError(`${label(cfg)} returned an empty response body.`, 500, res.status, 'empty_body')
      }

      const detail = await readError(cfg, res)
      clientSignal.removeEventListener('abort', onClientAbort)

      // Auth errors (401/403) indicate a bad key — try the next one immediately,
      // with no backoff. Waiting cannot un-revoke a key.
      if ((res.status === 401 || res.status === 403) && keyIndex < cfg.apiKeys.length - 1) {
        console.warn(
          '[%s] key %d/%d rejected (HTTP %d %s), falling back to next key',
          cfg.provider, keyIndex + 1, cfg.apiKeys.length, res.status, detail.type,
        )
        lastError = detail
        break
      }

      // The gateway is sick. Hand straight over to the backup when there is
      // one; otherwise treat it as retryable, which is what it used to be.
      if (CROSS_NOW.has(res.status)) {
        if (crossFast) throw toUpstreamError(cfg, res.status, detail)
        if (attempt < MAX_ATTEMPTS) {
          lastError = detail
          await backoff(attempt, clientSignal)
          continue
        }
      } else if (RETRY_IN_PLACE.has(res.status) && attempt < MAX_ATTEMPTS) {
        lastError = detail
        await backoff(attempt, clientSignal)
        continue
      }

      // Non-retryable error, or retries exhausted — try next key if available.
      // Worth doing even for a 400: AgentRouter keys can differ in which models
      // they may call, so `model_unavailable` really can be per-key.
      if (keyIndex < cfg.apiKeys.length - 1) {
        console.warn(
          '[%s] key %d/%d failed (HTTP %d %s), falling back to next key',
          cfg.provider, keyIndex + 1, cfg.apiKeys.length, res.status, detail.type,
        )
        lastError = detail
        break
      }

      throw toUpstreamError(cfg, res.status, detail)
    }
  }

  throw new UpstreamError(
    `${label(cfg)} failed after ${cfg.apiKeys.length} key(s) × ${MAX_ATTEMPTS} attempts: ${describe(lastError)}`,
    500,
    undefined,
    'upstream_retries_exhausted',
  )
}

/**
 * Fetches the model list the key is allowed to use — handy for debugging.
 *
 * Tries each configured key in order and returns the first successful response.
 * If no key succeeds, the last failed response (or error) is returned.
 */
export async function listModels(cfg: UpstreamConfig, clientSignal: AbortSignal): Promise<Response> {
  let last: Response | undefined
  for (const apiKey of cfg.apiKeys) {
    try {
      const res = await fetch(`${cfg.baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(cfg.userAgent ? { 'User-Agent': cfg.userAgent } : {}),
        },
        signal: clientSignal,
      })
      if (res.ok) return res
      last = res
    } catch (err) {
      console.warn('[%s] listModels failed with a key: %s', cfg.provider, describe(err))
      // Network error — try the next key if there is one.
      continue
    }
  }
  // If every key was tried and none succeeded, return whatever came last.
  return last ?? new Response(null, { status: 502 })
}

// ---------------------------------------------------------------------------
// Session titles
// ---------------------------------------------------------------------------

/** How much of each turn the titler sees. A name needs the opening, not the essay. */
const TITLE_SOURCE_CHARS = 800
/**
 * Token ceiling for a title request.
 *
 * Generous for eight words on purpose: this is a reasoning model, and thinking
 * tokens come out of `max_completion_tokens` too, so a tight cap returns an
 * empty message rather than a short title.
 */
const TITLE_MAX_TOKENS = 512
/** Background work — give up quickly rather than keeping the Worker alive for it. */
const TITLE_TIMEOUT_MS = 20_000
/** Words a title may keep. Matches the ask below, and `makeTitle` in `db/sessions.ts`. */
const TITLE_WORD_LIMIT = 8
/** Hard character cap, for when eight words are eight long words. */
const TITLE_CHAR_LIMIT = 64

const TITLE_SYSTEM_PROMPT = [
  'You name chat conversations.',
  'Reply with nothing but a title of 3-8 words, written in the language the user used.',
  'No quotation marks, no trailing punctuation, no "Title:" prefix, no markdown.',
  'Name the actual subject rather than the genre: "Fix D1 batch statement limit", not "Technical question".',
].join(' ')

/**
 * Names a session from its first completed exchange.
 *
 * Best effort by design: every failure path returns null instead of throwing.
 * The caller runs this in `waitUntil` after the reply has already reached the
 * user, and a sidebar row keeping its placeholder title is a far smaller problem
 * than a rejected background task.
 *
 * Deliberately not routed through `createChatCompletion`, which hardcodes
 * `stream: true` and a 3×3 retry ladder — both wrong for a throwaway request.
 * One pass per key, like `listModels`.
 */
export async function generateTitle(
  cfg: UpstreamConfig,
  exchange: { user: string; assistant: string },
  signal?: AbortSignal,
): Promise<string | null> {
  const body = JSON.stringify({
    model: cfg.model,
    messages: [
      { role: 'system', content: TITLE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Name this conversation.\n\nUser:\n${clip(exchange.user)}\n\nAssistant:\n${clip(exchange.assistant)}`,
      },
    ],
    stream: false,
    // Same per-gateway rules as `buildBody`, and no `temperature` at all.
    // Effort is pinned rather than inherited from `cfg.reasoningEffort`, which a
    // deployment may have set to `high` — a minute of deliberation over eight
    // words is not a trade worth making.
    [cfg.tokenParam]: TITLE_MAX_TOKENS,
    ...(cfg.sendReasoningEffort ? { reasoning_effort: 'low' } : {}),
  })

  for (let keyIndex = 0; keyIndex < cfg.apiKeys.length; keyIndex++) {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)

    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKeys[keyIndex]}`,
          'Content-Type': 'application/json',
          // Not `upstreamHeaders`: that one asks for text/event-stream.
          Accept: 'application/json',
          // Required by a whitelisting gateway — see the note at the top.
          ...(cfg.userAgent ? { 'User-Agent': cfg.userAgent, 'X-App': 'cli' } : {}),
        },
        body,
        signal: controller.signal,
      })
      if (!res.ok) {
        const detail = await readError(cfg, res)
        console.warn(
          '[%s] generateTitle: key %d/%d returned HTTP %d %s',
          cfg.provider, keyIndex + 1, cfg.apiKeys.length, res.status, detail.type,
        )
        continue
      }
      const title = cleanTitle(completionText(await res.json()))
      if (title) return title
      console.warn(
        '[%s] generateTitle: key %d/%d returned no usable title',
        cfg.provider, keyIndex + 1, cfg.apiKeys.length,
      )
    } catch (err) {
      // The client went away, or the deadline passed. Either way, no title.
      if (signal?.aborted) return null
      console.warn('[%s] generateTitle failed with a key: %s', cfg.provider, describe(err))
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  return null
}

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > TITLE_SOURCE_CHARS ? `${trimmed.slice(0, TITLE_SOURCE_CHARS)}…` : trimmed
}

/** Text of the first choice of a non-streaming completion, or ''. */
function completionText(payload: unknown): string {
  const content = (payload as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message
    ?.content
  if (typeof content === 'string') return content
  // Some OpenAI-compatible gateways answer with the multimodal part array even
  // when the request was plain text.
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : ''))
      .join('')
  }
  return ''
}

/**
 * Turns a model's answer into something that fits a sidebar row.
 *
 * The prompt asks for a bare title; this assumes it did not get one. Models
 * answer the question they were asked ("Title: ..."), wrap strings in quotes,
 * and add a full stop, and none of that survives contact with a 200px-wide row.
 */
function cleanTitle(raw: string): string {
  const line = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const stripped = line
    .replace(/^(?:chat\s+)?title\s*[:\-—]\s*/i, '')
    // Quotes of every flavour, plus stray markdown emphasis around the whole.
    .replace(/^["'“”‘’`*_]+/, '')
    .replace(/["'“”‘’`*_]+$/, '')
    .replace(/[.,;:!?]+$/, '')
    .trim()
  if (!stripped) return ''

  const words = stripped.split(/\s+/).slice(0, TITLE_WORD_LIMIT).join(' ')
  return words.length > TITLE_CHAR_LIMIT ? words.slice(0, TITLE_CHAR_LIMIT).trimEnd() : words
}

interface UpstreamErrorBody {
  message: string
  type: string
}

async function readError(cfg: UpstreamConfig, res: Response): Promise<UpstreamErrorBody> {
  let text = ''
  try {
    text = await res.text()
  } catch {
    /* body already gone */
  }
  try {
    const json = JSON.parse(text) as {
      error?: { message?: string; type?: string }
      message?: string
      type?: string
    }
    const message = json.error?.message ?? json.message ?? text
    const type = json.error?.type ?? json.type ?? 'upstream_error'
    return { message: String(message).slice(0, 600), type }
  } catch {
    // Non-JSON almost always means an HTML page from the edge, not the gateway.
    return {
      message: text.slice(0, 300) || `${label(cfg)} returned HTTP ${res.status}`,
      type: 'upstream_non_json',
    }
  }
}

/** Human name for messages the user may end up reading. */
function label(cfg: UpstreamConfig): string {
  return cfg.provider === 'agentrouter' ? 'AgentRouter' : 'freemodel.dev'
}

/**
 * Classifies an upstream HTTP failure.
 *
 * Two rules to preserve. First, never return 404/502/503 — the frontend treats
 * those as "no backend yet" and quietly swaps in a mock reply, which would hide
 * a real error. Second, `crossable` is false only when *we* built a bad request:
 * a second gateway would reject the same body, so crossing over would spend
 * money on a second refusal and delay the error the user needs to see.
 */
function toUpstreamError(
  cfg: UpstreamConfig,
  upstreamStatus: number,
  detail: UpstreamErrorBody,
): UpstreamError {
  // AgentRouter's client whitelist. Our UA is wrong *for this gateway*; a
  // gateway without a whitelist would have taken the same request happily.
  if (detail.type === 'unauthorized_client_error') {
    return new UpstreamError(
      `${label(cfg)} rejected this client. Its edge only accepts claude-cli-shaped User-Agents — check the AGENTROUTER_USER_AGENT var.`,
      500,
      upstreamStatus,
      detail.type,
    )
  }
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return new UpstreamError(
      `${label(cfg)} rejected the API key (${detail.message}). Regenerate it at https://agentrouter.org/console/token.`,
      500,
      upstreamStatus,
      'invalid_api_key',
    )
  }
  if (upstreamStatus === 429) {
    return new UpstreamError(
      `${label(cfg)} rate limit or quota reached: ${detail.message}`,
      429,
      upstreamStatus,
      'rate_limited',
    )
  }
  // An outage shape, not a malformed request: this key or this gateway cannot
  // serve the model right now, but another gateway serves a different one.
  if (upstreamStatus === 400 && /model/i.test(detail.message)) {
    return new UpstreamError(
      `${label(cfg)} will not serve this model: ${detail.message}. Check GET /api/models for what the key can access.`,
      400,
      upstreamStatus,
      'model_unavailable',
    )
  }
  // Any other 4xx is our own doing — do not pay a second gateway to agree.
  const ourFault = upstreamStatus >= 400 && upstreamStatus < 500
  return new UpstreamError(
    detail.message,
    upstreamStatus === 400 ? 400 : 500,
    upstreamStatus,
    detail.type,
    !ourFault,
  )
}

function describe(err: unknown): string {
  if (!err) return 'unknown error'
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message)
  return String(err)
}

function backoff(attempt: number, signal: AbortSignal): Promise<void> {
  const delay = 250 * 2 ** (attempt - 1)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delay)
    function onAbort() {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
