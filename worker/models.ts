/**
 * The model registry.
 *
 * Two entries: `gpt-5.6-sol` and `claude-opus-5`. The registry exists because
 * the *capabilities* need a home: the vision flag drives both the 400 the
 * backend returns for an image sent to a text-only model and the disabled state
 * of the attach button, and those two must agree. Adding a model is one entry in
 * this array -- the picker renders whatever is here, so it needs no edit.
 *
 * `GET /api/models` returns these records rather than AgentRouter's raw list.
 * The raw list is a debugging tool and lives at `GET /api/admin/models`.
 */

/**
 * Who actually trained the model, as distinct from which gateway serves it.
 *
 * AgentRouter serves both vendors, so `provider` cannot answer this -- and the
 * failover rule needs it: substituting one vendor's model for another is the one
 * crossover a user who picked deliberately would call a lie.
 */
export type Vendor = 'openai' | 'anthropic'

export interface ModelSpec {
  id: string
  label: string
  /** The name a user picks by. Short enough for a segmented control. */
  short: string
  provider: 'agentrouter'
  vendor: Vendor
  /** Accepts image content parts. Gates the attach button and `model_no_vision`. */
  vision: boolean
  /** Accepts extracted document text in context (all text models do). */
  documents: boolean
  contextTokens: number
  maxOutputTokens: number
  /** A reasoning model: takes `max_completion_tokens`, refuses `temperature`. */
  reasoning: boolean
  default?: boolean
  /** Shown in the picker when a capability is unproven; omitted when settled. */
  note?: string
}

/**
 * `vision: true` is *observed*, not assumed (PHASE2-PLAN.md §14, item 2 --
 * resolved). AgentRouter does forward multimodal content parts for
 * `gpt-5.6-sol`: `npm run probe:vision` posts generated images of known colour
 * and layout and the model reads them back correctly, including which half of a
 * split image is which. That last check matters -- a model that only answered
 * plausibly about colour could be guessing, and this flag existed precisely to
 * avoid claiming a capability nobody had watched work.
 *
 * The same is true of `claude-opus-5`, measured the same way. Every probe here
 * takes `AGENTROUTER_MODEL`, so pointing them at a second model is an env var
 * rather than a fork:
 *
 *   AGENTROUTER_MODEL=claude-opus-5 node scripts/probe-vision.mjs   -> 3/3
 *   AGENTROUTER_MODEL=claude-opus-5 node scripts/probe-tool-calling.mjs
 *       -> 10/10 trigger, 5/5 restraint, 5/5 round trip, 5/5 refusal,
 *          5/5 `tool_calls` over SSE in the `delta` form `sse.ts` expects
 *
 * Worth knowing about that last one: AgentRouter reaches Anthropic natively and
 * re-serialises, so the frames carry native `msg_01...` and `toolu_01...` ids
 * inside an otherwise ordinary OpenAI-compatible envelope. `peekToolCalls` reads
 * them without changes. The gateway is also *looser* than Anthropic's own API --
 * `temperature`, `max_tokens` and a `system` message role are all accepted where
 * `POST /v1/messages` answers 400 -- so `buildBody` needs no per-vendor branch.
 *
 * Re-run the probes before trusting any of this after a gateway change.
 */
export const MODELS: ModelSpec[] = [
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    short: 'ChatGPT',
    provider: 'agentrouter',
    vendor: 'openai',
    vision: true,
    documents: true,
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    default: true,
  },
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    short: 'Claude',
    provider: 'agentrouter',
    vendor: 'anthropic',
    vision: true,
    documents: true,
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    // Both numbers above are Anthropic's published limits and are display-only:
    // what the Worker actually sends is `MAX_OUTPUT_TOKENS` (`agentrouter.ts`),
    // and no code truncates against `contextTokens`.
    //
    // The note is the honest thing to show. `npm run probe:svg` phase 2 asks for
    // restraint -- four prompts that deserve no figure -- and `gpt-5.6-sol`
    // stays quiet on 8/8 where this model stayed quiet on 1/8, drawing for a
    // quadratic-formula derivation and a request for linked-list code.
    // `DIAGRAM_CLAUSE` was tuned against the other model and does not transfer.
    // Until it is retuned, say so rather than let it surprise anyone.
    note: 'Draws diagrams more eagerly than asked.',
  },
]

export function defaultModel(): ModelSpec {
  return MODELS.find((m) => m.default) ?? MODELS[0]
}

export function findModel(id: string | undefined): ModelSpec | undefined {
  if (!id) return undefined
  return MODELS.find((m) => m.id === id)
}

/**
 * Resolves a requested model id against the registry.
 *
 * An unknown id is rejected rather than falling back to the default: silently
 * answering with a different model than was asked for is worse than an error,
 * because the reply gets logged under the wrong `model_used`.
 */
export function resolveModel(id: string | undefined, configuredDefault: string): ModelSpec {
  if (id) {
    const found = findModel(id)
    if (!found) return unknownModel(id)
    return found
  }
  // The Worker's AGENTROUTER_MODEL var wins over the registry's `default` flag,
  // so changing the deployed model stays a config change.
  return findModel(configuredDefault) ?? defaultModel()
}

/** Sentinel for an id not in the registry; the caller turns it into a 400. */
function unknownModel(id: string): ModelSpec {
  return {
    id,
    label: id,
    short: id,
    provider: 'agentrouter',
    vendor: vendorOf(id),
    vision: false,
    documents: false,
    contextTokens: 0,
    maxOutputTokens: 0,
    reasoning: false,
  }
}

/**
 * Guesses a vendor from a model id, for ids the registry does not describe.
 *
 * Sniffing a string is not how any of the rest of this file works, and it is
 * deliberately confined to one caller that has no better source: the fallback
 * gateway's model comes from `FREEMODEL_MODEL`, an operator's free-text env var,
 * so there is no record to look it up in. `openai` is the default because the
 * fallback has served `gpt-5.5` since it was added, and because the direction of
 * the error matters -- see `chainFor` in `routes/chat.ts`, where guessing
 * `openai` can only ever *widen* a GPT request's failover, while a wrong guess
 * of `anthropic` would let a Claude request be answered by a GPT model, which is
 * the single thing that rule exists to prevent.
 */
export function vendorOf(modelId: string): Vendor {
  return /claude|anthropic/i.test(modelId) ? 'anthropic' : 'openai'
}

export function isKnownModel(id: string): boolean {
  return MODELS.some((m) => m.id === id)
}

/** The exact message the spec asks for when images meet a text-only model. */
export const NO_VISION_MESSAGE =
  'This model does not support image analysis. Please select a vision-capable model.'
