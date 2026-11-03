/**
 * Static catalog of upstream AI providers and public models.
 *
 * Exactly two upstream providers: AgentRouter and ApiNex.
 * Zero D1 queries on the routing path.
 */

export type ProviderKey = 'agentrouter' | 'apinex'

export interface ProviderConfig {
  key: ProviderKey
  label: string
  baseUrl: string
  protocol: 'responses' | 'chat_completions'
  headers: Record<string, string>
  keyEnvNames: string[]
  ttfbTimeoutMs: number
  totalTimeoutMs: number
  tokenParam: 'max_tokens' | 'max_output_tokens' | 'max_completion_tokens'
}

export interface ModelTarget {
  provider: ProviderKey
  upstreamModel: string
}

export interface ModelCapabilities {
  vision: boolean
  documents: boolean
  reasoning: boolean
  tools: boolean
}

export interface PublicModel {
  key: string
  name: string
  description: string
  aliases: string[]
  capabilities: ModelCapabilities
  targets: ModelTarget[]
  default?: boolean
}

export const PROVIDERS: Record<ProviderKey, ProviderConfig> = {
  agentrouter: {
    key: 'agentrouter',
    label: 'AgentRouter',
    baseUrl: 'https://agentrouter.org/v1',
    protocol: 'responses',
    headers: {
      'User-Agent': 'codex_cli_rs/0.40.0',
    },
    keyEnvNames: ['AGENTROUTER_API_KEY', 'AGENTROUTER_API_KEY_2', 'AGENTROUTER_API_KEY_3'],
    ttfbTimeoutMs: 20000,
    totalTimeoutMs: 180000,
    tokenParam: 'max_tokens',
  },
  apinex: {
    key: 'apinex',
    label: 'ApiNex',
    baseUrl: 'https://api.apinex.bond/v1',
    protocol: 'chat_completions',
    headers: {},
    keyEnvNames: ['APINEX_API_KEY', 'APINEX_API_KEY_2', 'APINEX_API_KEY_3'],
    ttfbTimeoutMs: 20000,
    totalTimeoutMs: 180000,
    tokenParam: 'max_tokens',
  },
}

/**
 * Priority target cascade across AgentRouter and ApiNex.
 * The primary is gpt-6.1-sol; if unreachable or ratelimited, it fails over silently.
 */
export const DEFAULT_TARGETS: ModelTarget[] = [
  { provider: 'agentrouter', upstreamModel: 'gpt-6.1-sol' },
  { provider: 'apinex', upstreamModel: 'gpt-6.1-sol' },
  { provider: 'agentrouter', upstreamModel: 'gpt-5.6-sol' },
  { provider: 'apinex', upstreamModel: 'free/gpt-6-luna' },
  { provider: 'agentrouter', upstreamModel: 'gpt-6-astra' },
]

export const MODELS: PublicModel[] = [
  {
    key: 'chatgpt',
    name: 'ChatGPT',
    description: 'Flagship general reasoning, coding, and multimodal intelligence.',
    aliases: [
      'chatgpt',
      'auto',
      'default',
      'gpt',
      'gpt-6.1-sol',
      'gpt-5.6-sol',
      'gpt-6-astra',
      'free/gpt-6-luna',
      'gemini',
      'claude',
      'deepseek',
      'glm',
      'grok',
    ],
    capabilities: {
      vision: true,
      documents: true,
      reasoning: true,
      tools: true,
    },
    targets: DEFAULT_TARGETS,
    default: true,
  },
]

/**
 * Resolves a model key or alias to a PublicModel.
 * Zero database lookup.
 */
export function resolveModel(requestedKey?: string | null): PublicModel {
  const req = requestedKey?.trim().toLowerCase()
  if (!req || req === 'auto' || req === 'default') {
    return MODELS.find((m) => m.default) ?? MODELS[0]
  }

  const direct = MODELS.find((m) => m.key === req)
  if (direct) return direct

  const alias = MODELS.find((m) => m.aliases.includes(req))
  if (alias) return alias

  // When unknown, fallback to default model
  return MODELS.find((m) => m.default) ?? MODELS[0]
}
