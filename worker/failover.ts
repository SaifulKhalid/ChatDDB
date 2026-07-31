/**
 * Cross-gateway failover — the reason an AgentRouter outage stops being visible.
 *
 * ChatDDB spoke to exactly one gateway, and AgentRouter fails often enough that
 * users noticed. This module puts a second gateway behind the first:
 * AgentRouter answers as it always has, and when it cannot, freemodel.dev
 * answers instead. Nobody is told. There is no picker, no provider badge, and
 * `src/` is untouched — the only externally visible difference is an
 * `X-ChatDDB-Upstream` response header that appears when the backup fired.
 *
 * ## Why the loop lives here and nowhere else
 *
 * There is one invariant worth protecting: **never restart a stream that has
 * already delivered bytes**, because the user would read the first half of one
 * answer followed by the whole of another.
 *
 * That invariant holds structurally rather than by care. `createChatCompletion`
 * resolves the moment upstream *headers* arrive, before a single body byte is
 * read, and `routes/chat.ts` only calls `toClientStream` on whatever this
 * function returns. So a retry loop sitting *above* `createChatCompletion` — as
 * this one does — cannot physically restart a live stream. Put the same logic
 * inside `toClientStream` and it could. A mid-flight death therefore still
 * surfaces as an SSE error frame from `sse.ts`, exactly as it did before.
 *
 * ## Why the fallback is a backup and not a peer
 *
 * `resolveProviders` still throws `NotConfiguredError` when AgentRouter is
 * absent, even with a freemodel key present. freemodel is metered ($5 of signup
 * credit, then paid), so a deployment that quietly ran entirely on the backup
 * would be spending money nobody chose to spend. Same reason `FALLBACK_ENABLED`
 * exists and the `upstream_failover` activity row is written: the spending has
 * to be visible.
 */

import {
  createChatCompletion,
  generateTitle,
  NotConfiguredError,
  resolveConfig,
  UpstreamError,
  type ChatMessage,
  type ProviderId,
  type UpstreamConfig,
} from './agentrouter.ts'
import { intVar, type WorkerEnv } from './env.ts'

/** freemodel's top tier. It does not serve `gpt-5.6-sol` — see PHASE2-2.md §5. */
export const DEFAULT_FALLBACK_MODEL = 'gpt-5.5'
/**
 * Note the bare host. `api.freemodel.dev` answered
 * `Failed to start container: Container service is restarting` while
 * `freemodel.dev` served the same route fine, so do not "tidy" this into an
 * `api.` subdomain.
 */
export const DEFAULT_FALLBACK_BASE_URL = 'https://freemodel.dev/v1'
/**
 * Shorter than the primary's 180 s. By the time the backup is asked, the user
 * has already spent whatever the primary wasted before giving up; a backup that
 * is also slow is not worth waiting three minutes for.
 */
export const FALLBACK_TIMEOUT_MS = 120_000

/** Which gateway answered, and with what. */
export interface UpstreamAttempt {
  /** Streaming response, headers in and body still arriving. */
  res: Response
  /** The config that won — `generateTitle` reuses it so the titler agrees. */
  cfg: UpstreamConfig
  provider: ProviderId
  /** What actually served the turn. `gpt-5.5` on a crossover, not `gpt-5.6-sol`. */
  model: string
  /** True when the primary failed first. Drives the header and the audit row. */
  crossedOver: boolean
}

/** Called once per crossover, before the backup is tried. */
export type CrossoverReporter = (from: ProviderId, to: ProviderId, err: UpstreamError) => void

/**
 * Builds the gateway chain: primary first, backup second, both optional-tail.
 *
 * `modelId` overrides the primary's model only — the registry id the user asked
 * for is meaningless to the backup, which serves a different catalogue.
 */
export function resolveProviders(env: WorkerEnv, modelId?: string): UpstreamConfig[] {
  // Throws NotConfiguredError when AgentRouter has no key. Deliberately not
  // caught: the backup does not substitute for a missing primary.
  const primary = resolveConfig(env)
  const providers: UpstreamConfig[] = [modelId ? { ...primary, model: modelId } : primary]

  const fallback = resolveFallback(env)
  if (fallback) providers.push(fallback)
  return providers
}

/**
 * The freemodel config, or null when it is unset or switched off.
 *
 * `tokenParam` and `sendReasoningEffort` are overridable from env because they
 * are properties of the *gateway*, discovered by `npm run probe:freemodel`, not
 * facts this code can know. Defaults match AgentRouter's reasoning-model shape;
 * if the probe disagrees, set the vars rather than editing the client.
 */
export function resolveFallback(env: WorkerEnv): UpstreamConfig | null {
  const apiKey = env.FREEMODEL_API_KEY?.trim()
  if (!apiKey || apiKey === 'fm-replace-me') return null
  // Kill switch: only the exact string disables it, so a typo fails safe (armed).
  if (env.FALLBACK_ENABLED?.trim() === 'false') return null

  return {
    provider: 'freemodel',
    apiKeys: [apiKey],
    baseUrl: (env.FREEMODEL_BASE_URL?.trim() || DEFAULT_FALLBACK_BASE_URL).replace(/\/+$/, ''),
    model: env.FREEMODEL_MODEL?.trim() || DEFAULT_FALLBACK_MODEL,
    // No `userAgent`: freemodel has no client whitelist, and sending a
    // claude-cli UA to a gateway that never asked for one is just noise.
    tokenParam: env.FREEMODEL_TOKEN_PARAM?.trim() === 'max_tokens' ? 'max_tokens' : 'max_completion_tokens',
    maxOutputTokens: intVar(env.MAX_OUTPUT_TOKENS, 8192),
    reasoningEffort: env.REASONING_EFFORT?.trim() || undefined,
    sendReasoningEffort: env.FREEMODEL_REASONING_EFFORT?.trim() !== 'false',
    timeoutMs: intVar(env.UPSTREAM_TIMEOUT_MS, FALLBACK_TIMEOUT_MS) || FALLBACK_TIMEOUT_MS,
  }
}

/** True when a fallback gateway is armed — reported by `/api/health`. */
export function fallbackReady(env: WorkerEnv): boolean {
  return resolveFallback(env) !== null
}

/**
 * Opens a completion on the first gateway that will take it.
 *
 * Every gateway but the last runs with `crossFast`, so a provider-wide failure
 * (unreachable, 5xx) abandons it on first sight instead of spending the
 * 3-attempts-per-key ladder — the user is still waiting on their first token, so
 * the whole point is to be quick about it. Per-key failures still walk the key
 * list first: one revoked key out of three is not an outage.
 *
 * A non-crossable error (`UpstreamError.crossable === false` — a request *we*
 * malformed) stops the chain immediately. So does an abort: the user pressed
 * Stop, and a second gateway is the last thing they want.
 */
export async function completeWithFailover(
  providers: UpstreamConfig[],
  messages: ChatMessage[],
  signal: AbortSignal,
  onCrossover?: CrossoverReporter,
): Promise<UpstreamAttempt> {
  if (providers.length === 0) {
    throw new NotConfiguredError('No upstream gateway is configured.')
  }

  for (let i = 0; i < providers.length; i++) {
    const cfg = providers[i]
    const next = providers[i + 1]

    try {
      const res = await createChatCompletion(cfg, messages, signal, { crossFast: next !== undefined })
      if (i > 0) {
        console.warn('[failover] %s answered after %s failed', cfg.provider, providers[0].provider)
      }
      return { res, cfg, provider: cfg.provider, model: cfg.model, crossedOver: i > 0 }
    } catch (err) {
      // The client hung up. Not a gateway problem, and nothing to fail over to.
      if (signal.aborted) throw err
      if (!next) throw err
      // Our request is malformed, or something unexpected broke. A second
      // gateway would refuse the same body — do not pay it to say so.
      if (!(err instanceof UpstreamError) || !err.crossable) throw err

      console.warn(
        '[failover] %s -> %s (%s, upstream %s): %s',
        cfg.provider, next.provider, err.type, err.upstreamStatus ?? '-', err.message,
      )
      onCrossover?.(cfg.provider, next.provider, err)
    }
  }

  // Unreachable: the final iteration either returns or throws.
  throw new NotConfiguredError('No upstream gateway is configured.')
}

/**
 * Names a session, trying the backup if the primary declines.
 *
 * One extra pass at most. `generateTitle` is best-effort and returns null
 * instead of throwing, so there is no error to inspect — a null just means
 * "ask the next one". `TITLE_TIMEOUT_MS` inside it bounds what this can cost,
 * and a session keeping its placeholder title is cosmetic either way.
 */
export async function titleWithFailover(
  providers: UpstreamConfig[],
  exchange: { user: string; assistant: string },
): Promise<string | null> {
  for (const cfg of providers) {
    const title = await generateTitle(cfg, exchange)
    if (title) return title
  }
  return null
}
