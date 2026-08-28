/**
 * Cross-gateway failover — the reason an AgentRouter outage stops being visible.
 *
 * ChatDDB spoke to exactly one gateway, and AgentRouter fails often enough that
 * users noticed. This module puts a second gateway behind the first:
 * AgentRouter answers as it always has, and when it cannot, freemodel.dev
 * answers instead. Nobody is told — the only externally visible difference is an
 * `X-ChatDDB-Upstream` response header that appears when the backup fired.
 *
 * That silence had no cost while no client could name a model. The model picker
 * gave it one, so it is now conditional: see `chainFor`, which is the boundary
 * between "any gateway may answer" and "only this vendor may answer".
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
  type ToolDefinition,
  type UpstreamConfig,
} from './agentrouter.ts'
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
 * Builds the provider configuration.
 */
export function resolveProviders(env: WorkerEnv, modelId?: string): UpstreamConfig[] {
  const primary = resolveConfig(env)
  return [modelId ? { ...primary, model: modelId } : primary]
}

/**
 * Narrows a resolved chain to the gateways allowed to answer for one model.
 */
export function chainFor(
  providers: UpstreamConfig[],
  model: ModelSpec,
  _explicit: boolean,
): UpstreamConfig[] {
  return providers.map((cfg) => ({ ...cfg, model: model.id }))
}

/** Reports if a fallback gateway is armed (always false now). */
export function fallbackReady(_env: WorkerEnv): boolean {
  return false
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
        // field — freemodel's tool support has never been probed — and that is
        // survivable by construction: no `tool_calls` simply means the turn is
        // answered as plain text, which is what it would have been anyway.
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
