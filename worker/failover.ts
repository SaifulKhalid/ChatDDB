/**
 * Cross-gateway failover logic.
 *
 * Puts the OpenRouter free-tier backup behind the primary provider to provide
 * resilience.
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
 * ## Why every model crosses over, Auto and explicit picks alike
 *
 * The old vendor rule — an explicit Claude pick may only be answered by an
 * Anthropic model — was dropped deliberately. The user asked for maximum
 * availability: a picked model that is down is *announced* ("GPT-5.6 Sol is
 * unavailable right now — answered by X instead") rather than preserved as a
 * hard failure. The attribution surfaces in `X-ChatDDB-Upstream` headers and
 * the `model_used` column records the truth, so the substitution is visible,
 * just not silent.
 *
 * ## Why the fallback is a backup and not a peer
 *
 * `resolveProviders` still throws `NotConfiguredError` when the primary provider is
 * unconfigured. An OpenRouter key alone does not make a deployment.
 */

import {
  createChatCompletion,
  generateTitle,
  NotConfiguredError,
  resolveConfig,
  resolveOpenRouterConfig,
  UpstreamError,
  type ChatMessage,
  type ProviderId,
  type ToolDefinition,
  type UpstreamConfig,
} from './provider.ts'
import type { WorkerEnv } from './env.ts'
import type { ModelSpec } from './models.ts'

/** Which gateway answered, and with what. */
export interface UpstreamAttempt {
  /** Streaming response, headers in and body still arriving. */
  res: Response
  /** The config that won — `generateTitle` reuses it so the titler agrees. */
  cfg: UpstreamConfig
  provider: ProviderId
  model: string
  /** True when a secondary key/gateway answered. */
  crossedOver: boolean
}

/** Called once per crossover, before the backup is tried. */
export type CrossoverReporter = (from: ProviderId, to: ProviderId, err: UpstreamError) => void

/**
 * Builds the provider chain: primary first, OpenRouter backup second.
 *
 * The backup is omitted (not an error) when it is unarmed or has no key, so a
 * deployment without it behaves exactly as it did before the backup existed.
 * The primary missing is still a `NotConfiguredError` — the backup alone is not
 * a configuration.
 */
export function resolveProviders(env: WorkerEnv, modelId?: string): UpstreamConfig[] {
  const primary = resolveConfig(env)
  const backup = resolveOpenRouterConfig(env)
  const head = modelId ? { ...primary, model: modelId } : primary
  return backup ? [head, backup] : [head]
}

/**
 * Narrows a resolved chain to the gateways allowed to answer one request.
 *
 * The one rule left: a turn carrying images drops a backup that is not declared
 * vision-capable. Forwarding an image to a model that will refuse it upstream
 * spends the user's wait for nothing — the primary already failed, so the turn
 * would error either way, only later. `OPENROUTER_VISION: 'true'` is the
 * operator's verified claim that the backup model takes image parts; it is
 * unset by default because an unverified claim is worse than no backup here.
 *
 * The primary is never filtered, so this can never empty the chain.
 */
export function chainFor(
  providers: UpstreamConfig[],
  _model: ModelSpec,
  hasImages: boolean,
): UpstreamConfig[] {
  if (!hasImages) return providers
  return providers.filter((cfg) => cfg.provider !== 'openrouter' || cfg.visionCapable === true)
}

/** Whether the OpenRouter backup is armed, for `GET /api/health`. */
export function fallbackReady(env: WorkerEnv): boolean {
  return resolveOpenRouterConfig(env) !== null
}

/** The armed backup's model id, or null — the health endpoint reports it. */
export function fallbackModel(env: WorkerEnv): string | null {
  return resolveOpenRouterConfig(env)?.model ?? null
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
  tools?: ToolDefinition[],
): Promise<UpstreamAttempt> {
  if (providers.length === 0) {
    throw new NotConfiguredError('No upstream gateway is configured.')
  }

  for (let i = 0; i < providers.length; i++) {
    const cfg = providers[i]
    const next = providers[i + 1]

    try {
      const res = await createChatCompletion(cfg, messages, signal, {
        crossFast: next !== undefined,
        // Offered to whichever gateway answers. The backup may well ignore the
        // field — the free-tier model's tool support is whatever it is — and
        // that is survivable by construction: no `tool_calls` simply means the
        // turn is answered as plain text, which is what it would have been
        // anyway.
        tools,
      })
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
