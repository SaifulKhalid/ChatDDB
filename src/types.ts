/**
 * Shared type definitions for PrototypeChatBot.
 */

import type { Ai } from "@cloudflare/workers-types";

export interface Env {
  // Bindings
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  AI: Ai;

  // Vars
  APP_NAME: string;
  MAX_UPLOAD_BYTES: string;
  FIREBASE_PROJECT_ID: string;
  /** Feature flag: set to "true" to enable the /api/test-openrouter endpoint. */
  ENABLE_TEST_OPENROUTER?: string;
  /** Rate limit: max requests per window. Defaults to 60. */
  RATE_LIMIT_MAX?: string;
  /** Rate limit: window in seconds. Defaults to 60. */
  RATE_LIMIT_WINDOW?: string;
  /** Guest quota: max messages per guest session (client ID-based). Defaults to 10. */
  GUEST_MAX_MESSAGES?: string;
  /** Guest quota: max file uploads per guest session. Defaults to 2. */
  GUEST_MAX_UPLOADS?: string;
  /** Guest quota: max image generations per guest session. Defaults to 2. */
  GUEST_MAX_IMAGE_GENS?: string;

  // Secrets (set via `wrangler secret put`)
  GROQ_API_KEY: string;
  GEMINI_API_KEY: string;
  AGENTROUTER_API_KEY: string;
  OPENROUTER_API_KEY: string;
}

export type Role = "user" | "assistant" | "system";

export interface AttachmentMeta {
  id: string;
  name: string;
  type: string;
  size: number;
  r2Key: string;
  kind: "image" | "pdf" | "file";
  /** Extracted text for PDFs/documents, used as context for the model. */
  extractedText?: string;
  /** Key for the optimized (resized/compressed) version of an image in R2. */
  optimizedR2Key?: string;
  /** Whether background processing is still in progress. */
  processing?: boolean;
  /** Key to the extracted text stored as a separate R2 object. */
  textR2Key?: string;
}

export interface DocumentChunk {
  id: string;
  attachment_id: string;
  chunk_index: number;
  chunk_text: string;
  token_estimate: number;
  created_at: number;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: Role;
  content: string;
  attachments: AttachmentMeta[];
  model: string | null;
  created_at: number;
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  created_at: number;
  updated_at: number;
}

/** A single turn sent to an AI provider. */
export interface ProviderMessage {
  role: Role;
  content: string;
  /** Inline image parts (base64 data URL or base64 raw) for vision-capable models. */
  images?: { mimeType: string; data: string }[];
}

export type Capability =
  | "chat"
  | "coding"
  | "reasoning"
  | "math"
  | "creative"
  | "vision"
  | "pdf-analysis"
  | "long-context"
  | "image-generation"
  | "image-editing"
  | "fast"
  | "cheap"
  | "premium";

/** Configuration for auto-selection of a provider. */
export interface ProviderConfig {
  provider: string;
  priority: number; // Lower = more preferred
  costTier: 1 | 2 | 3; // 1=cheapest, 3=most expensive
  models: string[];
  capabilities: Capability[];
}

/** Result of auto model selection. */
export interface ModelSelection {
  modelId: string;
  provider: string;
  reason: string;
}

export interface ChatRequest {
  conversationId: string;
  message: string;
  attachments?: AttachmentMeta[];
  model: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: "groq" | "gemini" | "agentrouter" | "openrouter" | "workers-ai";
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsImageGen?: boolean;
  supportsImageEditing?: boolean;
}

export const MODELS: ModelInfo[] = [
  // ── Chat Models (recommended order) ────────────────
  {
    id: "groq:llama-3.1-8b-instant",
    label: "Groq",
    provider: "groq",
    supportsVision: false,
    supportsStreaming: true,
  },
  {
    id: "workers-ai:@cf/meta/llama-4-scout-17b-16e-instruct",
    label: "Llama 4 Scout",
    provider: "workers-ai",
    supportsVision: true,
    supportsStreaming: true,
  },
  {
    id: "workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    label: "Llama 3.3 70B",
    provider: "workers-ai",
    supportsVision: false,
    supportsStreaming: true,
  },
  {
    id: "workers-ai:@cf/qwen/qwen3-30b-a3b-fp8",
    label: "Qwen3 30B",
    provider: "workers-ai",
    supportsVision: false,
    supportsStreaming: true,
  },
  {
    id: "gemini:gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    provider: "gemini",
    supportsVision: true,
    supportsStreaming: true,
  },
  {
    id: "agentrouter:claude-opus-4-8",
    label: "Claude",
    provider: "agentrouter",
    supportsVision: true,
    supportsStreaming: true,
  },
  {
    id: "agentrouter:gpt-5.6-sol",
    label: "ChatGPT",
    provider: "agentrouter",
    supportsVision: true,
    supportsStreaming: true,
  },
  // ── OpenRouter fallback (lowest priority) ──────────
  {
    id: "openrouter:inclusionai/ling-3.0-flash:free",
    label: "Ling 3.0 Flash",
    provider: "openrouter",
    supportsVision: false,
    supportsStreaming: true,
  },
  // ── Image Generation Models ────────────────────────
  {
    id: "workers-ai:@cf/black-forest-labs/flux-1-schnell",
    label: "FLUX.1 Schnell",
    provider: "workers-ai",
    supportsVision: false,
    supportsStreaming: false,
    supportsImageGen: true,
  },
  {
    id: "workers-ai:@cf/leonardo/lucid-origin",
    label: "Leonardo Lucid",
    provider: "workers-ai",
    supportsVision: false,
    supportsStreaming: false,
    supportsImageGen: true,
  },
];

export function getModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

/**
 * Merge hardcoded defaults with admin-defined models from D1.
 * Must be awaited — queries the admin_models table.
 */
export async function getMergedModels(env: Env): Promise<ModelInfo[]> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT model_id, label, provider, supports_vision, supports_streaming FROM admin_models ORDER BY provider, label"
    ).all<{ model_id: string; label: string; provider: string; supports_vision: number; supports_streaming: number }>();
    if (results && results.length > 0) {
      const adminModels: ModelInfo[] = results.map((r) => ({
        id: r.model_id,
        label: r.label,
        provider: r.provider as ModelInfo["provider"],
        supportsVision: r.supports_vision === 1,
        supportsStreaming: r.supports_streaming === 1,
      }));
      // Merge: admin models override hardcoded ones with same id, new ones are added
      const merged = [...MODELS];
      for (const am of adminModels) {
        const idx = merged.findIndex((m) => m.id === am.id);
        if (idx !== -1) {
          // Preserve flags that the admin_models table doesn't track
          merged[idx] = {
            ...am,
            supportsImageGen: merged[idx].supportsImageGen || am.supportsImageGen,
            supportsImageEditing: merged[idx].supportsImageEditing || am.supportsImageEditing,
          };
        } else {
          merged.push(am);
        }
      }
      return merged;
    }
  } catch {
    // If table doesn't exist or any error, fall back to hardcoded models
  }
  return MODELS;
}

export function parseModelId(id: string): { provider: string; model: string } {
  const idx = id.indexOf(":");
  if (idx === -1) return { provider: "", model: id };
  return { provider: id.slice(0, idx), model: id.slice(idx + 1) };
}