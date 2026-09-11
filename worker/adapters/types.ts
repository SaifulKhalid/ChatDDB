/**
 * Provider adapter interface and shared contracts.
 */

import type { ApiProviderRow } from '../db/aiRouting.ts'

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

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
