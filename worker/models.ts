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
export type Vendor = 'openai' | 'anthropic' | 'deepseek' | 'zhipu'

export interface ModelSpec {
  id: string
  label: string
  /** The name a user picks by. Short enough for a segmented control. */
  short: string
  provider: 'provider' | 'agentrouter'
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

export const MODELS: ModelSpec[] = [
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    short: 'DeepSeek',
    provider: 'provider',
    vendor: 'deepseek',
    vision: false,
    documents: true,
    contextTokens: 128_000,
    maxOutputTokens: 8_192,
    reasoning: false,
    default: true,
  },
  {
    id: 'glm-5.3',
    label: 'GLM 5.3',
    short: 'GLM',
    provider: 'provider',
    vendor: 'zhipu',
    vision: false,
    documents: true,
    contextTokens: 128_000,
    maxOutputTokens: 8_192,
    reasoning: true,
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    short: 'ChatGPT',
    provider: 'provider',
    vendor: 'openai',
    vision: true,
    documents: true,
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    reasoning: true,
  },
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    short: 'Claude',
    provider: 'provider',
    vendor: 'anthropic',
    vision: true,
    documents: true,
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: true,
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
  if (/claude|anthropic/i.test(modelId)) return 'anthropic'
  if (/deepseek/i.test(modelId)) return 'deepseek'
  if (/glm|zhipu/i.test(modelId)) return 'zhipu'
  return 'openai'
}

export function isKnownModel(id: string): boolean {
  return MODELS.some((m) => m.id === id)
}

/** The exact message the spec asks for when images meet a text-only model. */
export const NO_VISION_MESSAGE =
  'This model does not support image analysis. Please select a vision-capable model.'
