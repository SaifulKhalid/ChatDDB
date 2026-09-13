/**
 * Provider adapter interface and shared contracts.
 */

import type { ChatMessage, ToolDefinition } from '../provider.ts'
import type { ApiProviderRow } from '../db/aiRouting.ts'

export interface ProviderCredentials {
  apiKey?: string
  apiKeys?: string[]
}

export interface AdapterRequest {
  upstreamModel: string
  messages: ChatMessage[]
  clientSignal: AbortSignal
  tools?: ToolDefinition[]
  configuration?: {
    tokenParam?: 'max_tokens' | 'max_completion_tokens'
    maxOutputTokens?: number
    reasoningEffort?: string
    sendReasoningEffort?: boolean
  }
  customHeaders?: Record<string, string>
  timeoutMs?: number
}

export interface TestResult {
  ok: boolean
  latencyMs: number
  status?: number
  error?: string
}

export interface ProviderAdapter {
  executeChat(
    provider: ApiProviderRow,
    creds: ProviderCredentials,
    request: AdapterRequest,
  ): Promise<Response>

  testConnection(
    provider: ApiProviderRow,
    creds: ProviderCredentials,
  ): Promise<TestResult>

  testRoute(
    provider: ApiProviderRow,
    creds: ProviderCredentials,
    upstreamModelId: string,
  ): Promise<TestResult>
}
