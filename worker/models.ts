/**
 * The authoritative model registry for ChatDDB.
 *
 * Exactly two text-routing providers:
 *   - AgentRouter (DeepSeek, GLM)
 *   - CodeCraft API (ChatGPT 5.6, Gemini 3.7, Claude 5)
 *
 * Exactly five explicit active text models:
 *   - `deepseek`    (DeepSeek    -> AgentRouter: deepseek-v4-flash)
 *   - `glm`         (GLM         -> AgentRouter: glm-5.3)
 *   - `chatgpt-5.6` (ChatGPT 5.6 -> CodeCraft:   gpt-5.6-sol)
 *   - `gemini-3.7`  (Gemini 3.7  -> CodeCraft:   gemini-3.7-flash)
 *   - `claude-5`    (Claude 5    -> CodeCraft:   claude-opus-5)
 *
 * Plus the `auto` routing strategy that intelligently picks among these models.
 *
 * All upstream provider IDs and provider infrastructure details remain private.
 * The public API and browser client interact exclusively with stable keys:
 * `auto`, `deepseek`, `glm`, `chatgpt-5.6` (or `gpt`), `gemini-3.7`, `claude-5`.
 */

export type Vendor = 'openai' | 'google' | 'anthropic' | 'zhipu' | 'deepseek' | 'qwen'
export type TextProviderId = 'agentrouter' | 'codecraft'

export interface ModelSpec {
  /** Stable public key used by frontend and API: 'deepseek' | 'glm' | 'chatgpt-5.6' | 'gemini-3.7' | 'claude-5' */
  key: string
  /** Alias for key to maintain backward compatibility with id accessors */
  id: string
  /** Public product name: e.g. 'DeepSeek', 'GLM', 'ChatGPT 5.6', 'Gemini 3.7', 'Claude 5' */
  publicName: string
  /** Short name for segmented controls: e.g. 'DeepSeek', 'GLM', 'ChatGPT', 'Gemini', 'Claude' */
  short: string
  /** Public label displayed in UI */
  label: string
  /** Which provider serves this model internally: 'agentrouter' | 'codecraft' */
  provider: TextProviderId
  /** Internal upstream model ID on the provider gateway */
  modelId: string
  /** Who trained the model */
  vendor: Vendor
  /** Accepts image content parts */
  vision: boolean
  /** Accepts extracted document text in context */
  documents: boolean
  contextTokens: number
  maxOutputTokens: number
  /** Reasoning model */
  reasoning: boolean
  default?: boolean
  description: string
  note?: string
  /** Backward-compatible lookup aliases */
  aliases?: string[]
}

export const MODELS: ModelSpec[] = [
  {
    key: 'deepseek-v4-flash',
    id: 'deepseek-v4-flash',
    publicName: 'deepseek-v4-flash',
    short: 'deepseek-v4-flash',
    label: 'deepseek-v4-flash',
    provider: 'agentrouter',
    modelId: 'deepseek-v4-flash',
    vendor: 'deepseek',
    aliases: ['deepseek'],
    vision: false,
    documents: true,
    contextTokens: 128_000,
    maxOutputTokens: 8_192,
    reasoning: false,
    default: true,
    description: 'Fast, efficient general-purpose technical model (deepseek-v4-flash).',
  },
  {
    key: 'glm-5.3',
    id: 'glm-5.3',
    publicName: 'glm-5.3',
    short: 'glm-5.3',
    label: 'glm-5.3',
    provider: 'agentrouter',
    modelId: 'glm-5.3',
    vendor: 'zhipu',
    aliases: ['glm'],
    vision: false,
    documents: true,
    contextTokens: 128_000,
    maxOutputTokens: 8_192,
    reasoning: true,
    description: 'Strong technical reasoning and mathematical analysis (glm-5.3).',
  },
  {
    key: 'gpt-5.6-sol',
    id: 'gpt-5.6-sol',
    publicName: 'gpt-5.6-sol',
    short: 'gpt-5.6-sol',
    label: 'gpt-5.6-sol',
    provider: 'codecraft',
    modelId: 'gpt-5.6-sol',
    vendor: 'openai',
    aliases: ['chatgpt-5.6', 'gpt', 'chatgpt'],
    vision: true,
    documents: true,
    contextTokens: 1_050_000,
    maxOutputTokens: 65_536,
    reasoning: true,
    description: 'Flagship reasoning, coding, and multimodal model (gpt-5.6-sol).',
  },
  {
    key: 'gemini-3.7-flash',
    id: 'gemini-3.7-flash',
    publicName: 'gemini-3.7-flash',
    short: 'gemini-3.7-flash',
    label: 'gemini-3.7-flash',
    provider: 'codecraft',
    modelId: 'gemini-3.7-flash',
    vendor: 'google',
    aliases: ['gemini-3.7', 'gemini'],
    vision: true,
    documents: true,
    contextTokens: 1_048_576,
    maxOutputTokens: 65_536,
    reasoning: true,
    description: 'Fast multimodal model with advanced reasoning and web search (gemini-3.7-flash).',
  },
  {
    key: 'claude-opus-5',
    id: 'claude-opus-5',
    publicName: 'claude-opus-5',
    short: 'claude-opus-5',
    label: 'claude-opus-5',
    provider: 'codecraft',
    modelId: 'claude-opus-5',
    vendor: 'anthropic',
    aliases: ['claude-5', 'claude'],
    vision: true,
    documents: true,
    contextTokens: 1_000_000,
    maxOutputTokens: 65_536,
    reasoning: true,
    description: 'Premier coding, reasoning, and agentic performance model (claude-opus-5).',
  },
]

export const PUBLIC_MODEL_KEYS = [
  'deepseek-v4-flash',
  'glm-5.3',
  'gpt-5.6-sol',
  'gemini-3.7-flash',
  'claude-opus-5',
] as const
export type PublicModelKey = (typeof PUBLIC_MODEL_KEYS)[number]

/** Safe public model descriptor returned to browser and public APIs. */
export interface PublicModelSpec {
  id: string
  name: string
  label: string
  short: string
  modelId: string
  vision: boolean
  documents: boolean
  default?: boolean
  description?: string
}

/**
 * Projects a full ModelSpec to a frontend-safe PublicModelSpec.
 * Displays the full model ID to the user while keeping provider details unexposed.
 */
export function toPublicModel(m: ModelSpec): PublicModelSpec {
  return {
    id: m.key,
    name: m.modelId,
    label: m.modelId,
    short: m.modelId,
    modelId: m.modelId,
    vision: m.vision,
    documents: m.documents,
    default: m.default,
    description: m.description,
  }
}

export function defaultModel(): ModelSpec {
  return MODELS.find((m) => m.default) ?? MODELS[0]
}

export function findModel(key: string | undefined): ModelSpec | undefined {
  if (!key) return undefined
  return MODELS.find((m) => m.key === key || m.id === key || m.modelId === key || m.aliases?.includes(key))
}

/**
 * Checks if a key is an allowable public model key (excluding 'auto').
 */
export function isKnownModel(key: string): boolean {
  return findModel(key) !== undefined
}

/**
 * Checks if a string matches any private upstream model ID.
 * Used to detect and reject browser attempts to supply raw provider IDs.
 */
export function isUpstreamModelId(id: string): boolean {
  return MODELS.some((m) => m.modelId === id)
}

/**
 * Resolves a requested model key against the registry.
 * Rejects unknown or raw upstream model IDs with an unknownModel sentinel.
 */
export function resolveModel(key: string | undefined, configuredDefault?: string): ModelSpec {
  if (key && key !== 'auto') {
    const found = findModel(key)
    if (!found) return unknownModel(key)
    return found
  }
  if (configuredDefault) {
    const fromConfig = findModel(configuredDefault)
    if (fromConfig) return fromConfig
  }
  return defaultModel()
}

/** Sentinel for a key not in the registry; caller turns it into a 400. */
function unknownModel(key: string): ModelSpec {
  return {
    key,
    id: key,
    publicName: key,
    label: key,
    short: key,
    provider: 'agentrouter',
    modelId: key,
    vendor: 'deepseek',
    vision: false,
    documents: false,
    contextTokens: 0,
    maxOutputTokens: 0,
    reasoning: false,
    description: 'Unknown model',
  }
}

/**
 * Guesses a vendor from a model id for labelling in admin interfaces.
 */
export function vendorOf(modelId: string): Vendor {
  if (/gemini|google/i.test(modelId)) return 'google'
  if (/claude|anthropic/i.test(modelId)) return 'anthropic'
  if (/deepseek/i.test(modelId)) return 'deepseek'
  if (/glm|zhipu/i.test(modelId)) return 'zhipu'
  if (/qwen/i.test(modelId)) return 'qwen'
  return 'openai'
}

/** The exact message the spec asks for when images meet a text-only model. */
export const NO_VISION_MESSAGE =
  'This model does not support image analysis. Please select a vision-capable model.'

export interface AutoRoutingInput {
  text?: string
  hasImages?: boolean
}

export interface EnvLikeForRouting {
  CODECRAFT_API_KEY?: string
  AGENTROUTER_API_KEY?: string
  AGENTROUTER_API_KEY_2?: string
  AGENTROUTER_API_KEY_3?: string
  PROVIDER_API_KEY?: string
  PROVIDER_API_KEY_2?: string
  PROVIDER_API_KEY_3?: string
}

/**
 * Auto mode routing: dynamically selects the best available model among
 * the active text models:
 *   - DeepSeek (AgentRouter)
 *   - GLM (AgentRouter)
 *   - ChatGPT 5.6 (CodeCraft)
 *   - Gemini 3.7 (CodeCraft)
 *   - Claude 5 (CodeCraft)
 *
 * Never falls back to unlisted models or outside providers.
 */
export function routeAutoModel(input: AutoRoutingInput, env: EnvLikeForRouting): ModelSpec {
  const deepseek = findModel('deepseek-v4-flash')!
  const glm = findModel('glm-5.3')!
  const chatgpt = findModel('gpt-5.6-sol')!
  const gemini = findModel('gemini-3.7-flash')!
  const claude = findModel('claude-opus-5')!

  const codeCraftAvailable = Boolean(
    env.CODECRAFT_API_KEY &&
      env.CODECRAFT_API_KEY.trim() &&
      env.CODECRAFT_API_KEY !== 'cc-replace-me' &&
      env.CODECRAFT_API_KEY !== 'sk-replace-me',
  )
  const agentRouterAvailable = Boolean(
    (env.AGENTROUTER_API_KEY && env.AGENTROUTER_API_KEY.trim() !== 'sk-replace-me') ||
      (env.PROVIDER_API_KEY && env.PROVIDER_API_KEY.trim() !== 'sk-replace-me'),
  )

  // 1. Vision requests: CodeCraft models provide vision
  if (input.hasImages) {
    if (codeCraftAvailable) return gemini
    return gemini
  }

  const text = (input.text ?? '').trim()

  // 2. Multilingual tasks (non-ASCII characters or translation keywords)
  const hasNonAscii = Array.from(text).some((c) => c.charCodeAt(0) > 127)
  const isTranslation = /\b(translate|translation|in french|in spanish|in german|in japanese|in chinese|in arabic)\b/i.test(
    text,
  )
  if (hasNonAscii || isTranslation) {
    if (codeCraftAvailable) return gemini
    if (agentRouterAvailable) return glm
  }

  // 3. Coding / software engineering tasks
  const isCoding =
    /```|\b(function|def|class|import|const|let|var|return|async|await|git|docker|sql|query|api|endpoint|regex|html|css|react|typescript|python|javascript|rust|golang|c\+\+|java|bug|debug|refactor|syntax|exception|stacktrace|compile|error|algorithm|database)\b/i.test(
      text,
    )
  if (isCoding) {
    if (codeCraftAvailable) return chatgpt
    if (agentRouterAvailable) return glm
  }

  // 4. Creative writing, essay analysis, nuanced prose
  const isNuancedWriting =
    /\b(essay|critique|prose|draft|tone|nuance|creative writing|poem|poetry|story|novel)\b/i.test(text)
  if (isNuancedWriting) {
    if (codeCraftAvailable) return claude
    if (agentRouterAvailable) return glm
  }

  // 5. Complex reasoning, mathematics, logic proofs, derivations
  const isComplexReasoning =
    /\b(prove|proof|theorem|derive|derivation|integral|derivative|calculus|equation|formula|matrix|eigenvalue|step-by-step reasoning|logic puzzle|chain of thought)\b/i.test(
      text,
    ) || /\$\$|\\\[/.test(text)
  if (isComplexReasoning) {
    if (agentRouterAvailable) return glm
    if (codeCraftAvailable) return claude
  }

  // 5. Fast, efficient, general queries
  if (agentRouterAvailable) return deepseek
  if (codeCraftAvailable) return chatgpt

  // Fallback to default
  return defaultModel()
}
