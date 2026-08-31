/**
 * The OpenAI-compatible upstream provider client.
 *
 * Speaks plain `/v1/chat/completions` to whichever gateway a `UpstreamConfig` points
 * at. Everything a gateway can disagree about lives in the config, so no
 * function here branches on provider specifics; that field exists to label logs and to
 * record which gateway actually answered.
 */

export const DEFAULT_BASE_URL = 'https://agentrouter.org/v1'
export const DEFAULT_MODEL = 'deepseek-v4-flash'
export const DEFAULT_USER_AGENT = 'claude-cli/2.1.158 (external, sdk-cli)'
export const DEFAULT_TIMEOUT_MS = 180_000

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
/**
 * The backup's model. A `:free` id verified against the live catalog by
 * `npm run probe:openrouter` — free ids rotate, so this is a config fact, not
 * a code fact, and `OPENROUTER_MODEL` overrides it without a deploy.
 */
export const DEFAULT_OPENROUTER_MODEL = 'z-ai/glm-5.2:free'

/**
 * Which gateway a config points at. Labels logs, `chat_messages.model_provider`,
 * and error text. The only place a gateway identity is branched on is `label()`
 * and the attribution headers in `upstreamHeaders` — everything else a gateway
 * can disagree about lives in the `UpstreamConfig` fields.
 */
export type ProviderId = 'provider' | 'openrouter'

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

/**
 * A multimodal content part, in OpenAI's shape.
 *
 * Only used when a turn actually carries an image. A text-only turn keeps
 * `content` as a plain string.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

/**
 * A tool the model may call, in OpenAI's `tools` shape.
 */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    /** JSON Schema for the arguments. Passed through verbatim. */
    parameters: Record<string, unknown>
  }
}

/** One call the model asked for. `arguments` is JSON *as a string*, per OpenAI. */
export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: ChatRole
  content: string | ContentPart[] | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
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
  /**
   * Operator's verified claim that this gateway's model accepts image content
   * parts. Absent on the primary (whose models each carry a registry `vision`
   * flag); on the backup it gates whether image turns may cross over to it —
   * see `chainFor` in `failover.ts`.
   */
  visionCapable?: boolean
  /** Applies to time-to-first-byte only, never to an in-flight stream. */
  timeoutMs: number
}

export type ProviderConfig = UpstreamConfig
export type AgentRouterConfig = UpstreamConfig
export type OpenRouterConfig = UpstreamConfig

/** The API key is missing, so the backend cannot serve completions. */
export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotConfiguredError'
  }
}

/** A gateway (or the provider behind it) returned a failure. */
export class UpstreamError extends Error {
  readonly status: number
  readonly upstreamStatus: number | undefined
  readonly type: string
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
  PROVIDER_API_KEY?: string
  PROVIDER_API_KEY_2?: string
  PROVIDER_API_KEY_3?: string
  API_PROVIDER_BASE_URL?: string
  API_PROVIDER_MODEL?: string
  API_PROVIDER_USER_AGENT?: string
  AGENTROUTER_API_KEY?: string
  AGENTROUTER_API_KEY_2?: string
  AGENTROUTER_API_KEY_3?: string
  AGENTROUTER_BASE_URL?: string
  AGENTROUTER_MODEL?: string
  AGENTROUTER_USER_AGENT?: string
  MAX_OUTPUT_TOKENS?: string
  REASONING_EFFORT?: string
  UPSTREAM_TIMEOUT_MS?: string
  // ---- OpenRouter backup --------------------------------------------------
  OPENROUTER_API_KEY?: string
  OPENROUTER_BASE_URL?: string
  OPENROUTER_MODEL?: string
  OPENROUTER_ENABLED?: string
  OPENROUTER_TOKEN_PARAM?: string
  OPENROUTER_REASONING_EFFORT?: string
  OPENROUTER_VISION?: string
}

function intVar(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function collectApiKeys(env: EnvLike): string[] {
  const keys: string[] = []
  const candidates = [
    env.PROVIDER_API_KEY,
    env.PROVIDER_API_KEY_2,
    env.PROVIDER_API_KEY_3,
    env.AGENTROUTER_API_KEY,
    env.AGENTROUTER_API_KEY_2,
    env.AGENTROUTER_API_KEY_3,
  ]
  for (const raw of candidates) {
    const trimmed = raw?.trim()
    if (trimmed && trimmed !== 'sk-replace-me' && !keys.includes(trimmed)) {
      keys.push(trimmed)
    }
  }
  return keys
}

export function resolveConfig(env: EnvLike): UpstreamConfig {
  const apiKeys = collectApiKeys(env)
  if (apiKeys.length === 0) {
    throw new NotConfiguredError(
      'No PROVIDER_API_KEY is set. Locally: copy .dev.vars.example to ' +
        '.dev.vars and paste your key(s). Deployed: npx wrangler secret put PROVIDER_API_KEY.',
    )
  }
  const baseUrl = (env.API_PROVIDER_BASE_URL?.trim() || env.AGENTROUTER_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = env.API_PROVIDER_MODEL?.trim() || env.AGENTROUTER_MODEL?.trim() || DEFAULT_MODEL
  const userAgent = env.API_PROVIDER_USER_AGENT?.trim() || env.AGENTROUTER_USER_AGENT?.trim() || DEFAULT_USER_AGENT

  return {
    provider: 'provider',
    apiKeys,
    baseUrl,
    model,
    userAgent,
    tokenParam: 'max_completion_tokens',
    maxOutputTokens: intVar(env.MAX_OUTPUT_TOKENS, 8192),
    reasoningEffort: env.REASONING_EFFORT?.trim() || undefined,
    sendReasoningEffort: true,
    timeoutMs: intVar(env.UPSTREAM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  }
}

/**
 * The OpenRouter backup, or null when it is unarmed or has no key.
 *
 * Null — never a throw — when unconfigured: the backup is an add-on, and a
 * deployment without it must boot exactly as it did before the backup existed.
 * A *configured-but-unusable* backup (armed, key set, gateway refusing) is a
 * runtime crossover problem, not a boot problem.
 *
 * The kill switch follows the `POLLINATIONS_ENABLED` convention: only the exact
 * string `'false'` disarms, so a typo fails armed rather than silently removing
 * the fallback.
 */
export function resolveOpenRouterConfig(env: EnvLike): UpstreamConfig | null {
  if (env.OPENROUTER_ENABLED?.trim() === 'false') return null
  const apiKey = env.OPENROUTER_API_KEY?.trim()
  if (!apiKey || apiKey === 'sk-or-replace-me') return null

  const tokenParam =
    env.OPENROUTER_TOKEN_PARAM?.trim() === 'max_completion_tokens'
      ? ('max_completion_tokens' as const)
      : ('max_tokens' as const)

  return {
    provider: 'openrouter',
    apiKeys: [apiKey],
    baseUrl: (env.OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, ''),
    model: env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL,
    // No User-Agent: the claude-cli string is an AgentRouter whitelist
    // artifact, and `upstreamHeaders` sends OpenRouter's attribution headers
    // instead. Undefined, not empty — the header set is keyed on its presence.
    userAgent: undefined,
    tokenParam,
    maxOutputTokens: intVar(env.MAX_OUTPUT_TOKENS, 8192),
    reasoningEffort: env.REASONING_EFFORT?.trim() || undefined,
    sendReasoningEffort: env.OPENROUTER_REASONING_EFFORT?.trim() !== 'false',
    // `OPENROUTER_VISION` is the operator's claim, verified by eye or by the
    // probe — not something this code can know for a free-text model id.
    visionCapable: env.OPENROUTER_VISION?.trim() === 'true',
    timeoutMs: intVar(env.UPSTREAM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  }
}

export function upstreamHeaders(cfg: UpstreamConfig, apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...(cfg.provider === 'openrouter'
      ? // OpenRouter's optional attribution headers. Free-tier keys rank by app
        // in the dashboard, and these cost nothing. No User-Agent spoofing: the
        // claude-cli one is an AgentRouter client-whitelist artifact.
        { 'HTTP-Referer': 'https://chatddb.app', 'X-Title': 'ChatDDB' }
      : cfg.userAgent
        ? { 'User-Agent': cfg.userAgent, 'X-App': 'cli' }
        : {}),
  }
}

function buildBody(cfg: UpstreamConfig, messages: ChatMessage[], tools?: ToolDefinition[]): string {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (cfg.maxOutputTokens > 0) body[cfg.tokenParam] = cfg.maxOutputTokens
  if (cfg.reasoningEffort && cfg.sendReasoningEffort) body.reasoning_effort = cfg.reasoningEffort
  if (tools && tools.length > 0) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  return JSON.stringify(body)
}

const RETRY_IN_PLACE = new Set([408, 429])
const CROSS_NOW = new Set([402, 500, 502, 503, 504, 522, 524])
const MAX_ATTEMPTS = 3

export interface CompletionOptions {
  crossFast?: boolean
  tools?: ToolDefinition[]
}

/**
 * Opens a streaming chat completion. Resolves once upstream headers are in,
 * so the returned Response body is still being produced.
 */
export async function createChatCompletion(
  cfg: UpstreamConfig,
  messages: ChatMessage[],
  clientSignal: AbortSignal,
  options: CompletionOptions = {},
): Promise<Response> {
  const crossFast = options.crossFast ?? false
  const url = `${cfg.baseUrl}/chat/completions`
  const body = buildBody(cfg, messages, options.tools)
  let lastError: unknown

  for (let keyIndex = 0; keyIndex < cfg.apiKeys.length; keyIndex++) {
    const apiKey = cfg.apiKeys[keyIndex]

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (clientSignal.aborted) throw new DOMException('Aborted', 'AbortError')

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

      clearTimeout(timer)

      if (res.ok && res.body) {
        return res
      }

      if (res.ok && !res.body) {
        clientSignal.removeEventListener('abort', onClientAbort)
        throw new UpstreamError(`${label(cfg)} returned an empty response body.`, 500, res.status, 'empty_body')
      }

      const detail = await readError(cfg, res)
      clientSignal.removeEventListener('abort', onClientAbort)

      if ((res.status === 401 || res.status === 403) && keyIndex < cfg.apiKeys.length - 1) {
        console.warn(
          '[%s] key %d/%d rejected (HTTP %d %s), falling back to next key',
          cfg.provider, keyIndex + 1, cfg.apiKeys.length, res.status, detail.type,
        )
        lastError = detail
        break
      }

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
      continue
    }
  }
  return last ?? new Response(null, { status: 502 })
}

const TITLE_SOURCE_CHARS = 800
const TITLE_MAX_TOKENS = 512
const TITLE_TIMEOUT_MS = 20_000
const TITLE_WORD_LIMIT = 8
const TITLE_CHAR_LIMIT = 64

const TITLE_SYSTEM_PROMPT = [
  'You name chat conversations.',
  'Reply with nothing but a title of 3-8 words, written in the language the user used.',
  'No quotation marks, no trailing punctuation, no "Title:" prefix, no markdown.',
  'Name the actual subject rather than the genre: "Fix D1 batch statement limit", not "Technical question".',
].join(' ')

/**
 * Names a session from its first completed exchange.
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
          Accept: 'application/json',
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

function completionText(payload: unknown): string {
  const content = (payload as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message
    ?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : ''))
      .join('')
  }
  return ''
}

function cleanTitle(raw: string): string {
  const line = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const stripped = line
    .replace(/^(?:chat\s+)?title\s*[:\-—]\s*/i, '')
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
    return {
      message: text.slice(0, 300) || `${label(cfg)} returned HTTP ${res.status}`,
      type: 'upstream_non_json',
    }
  }
}

/** The one place a gateway identity is branched on, for logs and error text. */
function label(cfg: UpstreamConfig): string {
  return cfg.provider === 'openrouter' ? 'OpenRouter' : 'API Provider'
}

function toUpstreamError(
  cfg: UpstreamConfig,
  upstreamStatus: number,
  detail: UpstreamErrorBody,
): UpstreamError {
  if (detail.type === 'unauthorized_client_error') {
    return new UpstreamError(
      `${label(cfg)} rejected this client. Check the API_PROVIDER_USER_AGENT variable.`,
      500,
      upstreamStatus,
      detail.type,
    )
  }
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return new UpstreamError(
      `${label(cfg)} rejected the API key (${detail.message}). Please verify your PROVIDER_API_KEY.`,
      500,
      upstreamStatus,
      'invalid_api_key',
    )
  }
  if (upstreamStatus === 402) {
    return new UpstreamError(
      `${label(cfg)} quota or budget pool exhausted: ${detail.message}`,
      402,
      upstreamStatus,
      'quota_exhausted',
      true,
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
  if (upstreamStatus === 400 && /model/i.test(detail.message)) {
    return new UpstreamError(
      `${label(cfg)} will not serve this model: ${detail.message}. Check GET /api/models for what the key can access.`,
      400,
      upstreamStatus,
      'model_unavailable',
    )
  }
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
