/**
 * The model registry.
 *
 * One entry for now -- `gpt-5.6-sol` -- which is the decision that was made for
 * Phase 2. The registry exists anyway because the *capabilities* need a home:
 * the vision flag drives both the 400 the backend returns for an image sent to a
 * text-only model and the disabled state of the attach button, and those two
 * must agree. Adding a model later is one entry in this array.
 *
 * `GET /api/models` returns these records rather than AgentRouter's raw list.
 * The raw list is a debugging tool and lives at `GET /api/admin/models`.
 */

export interface ModelSpec {
  id: string
  label: string
  provider: 'agentrouter'
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
 * `vision: true` is *observed*, not assumed (PHASE2-PLAN.md §14, item 2 —
 * resolved). AgentRouter does forward multimodal content parts for
 * `gpt-5.6-sol`: `npm run probe:vision` posts generated images of known colour
 * and layout and the model reads them back correctly, including which half of a
 * split image is which. That last check matters — a model that only answered
 * plausibly about colour could be guessing, and this flag existed precisely to
 * avoid claiming a capability nobody had watched work.
 *
 * Re-run the probe before trusting this after a gateway change.
 */
export const MODELS: ModelSpec[] = [
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    provider: 'agentrouter',
    vision: true,
    documents: true,
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    default: true,
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
    provider: 'agentrouter',
    vision: false,
    documents: false,
    contextTokens: 0,
    maxOutputTokens: 0,
    reasoning: false,
  }
}

export function isKnownModel(id: string): boolean {
  return MODELS.some((m) => m.id === id)
}

/** The exact message the spec asks for when images meet a text-only model. */
export const NO_VISION_MESSAGE =
  'This model does not support image analysis. Please select a vision-capable model.'
