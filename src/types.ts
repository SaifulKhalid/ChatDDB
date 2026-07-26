/**
 * Shared type definitions for PrototypeChatBot.
 */

export interface Env {
  // Bindings
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;

  // Vars
  APP_NAME: string;
  MAX_UPLOAD_BYTES: string;

  // Secrets (set via `wrangler secret put`)
  GROQ_API_KEY: string;
  GEMINI_API_KEY: string;
  AGENTROUTER_API_KEY: string;
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

export interface ChatRequest {
  conversationId: string;
  message: string;
  attachments?: AttachmentMeta[];
  model: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: "groq" | "gemini" | "agentrouter";
  supportsVision: boolean;
  supportsStreaming: boolean;
}

export const MODELS: ModelInfo[] = [
  {
    id: "groq:llama-3.1-8b-instant",
    label: "Groq",
    provider: "groq",
    supportsVision: false,
    supportsStreaming: true,
  },
  {
    id: "gemini:gemini-2.5-flash",
    label: "Gemini",
    provider: "gemini",
    supportsVision: true,
    supportsStreaming: true,
  },
  {
    id: "agentrouter:kimi-k3",
    label: "Kimi",
    provider: "agentrouter",
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
];

export function getModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

export function parseModelId(id: string): { provider: string; model: string } {
  const idx = id.indexOf(":");
  if (idx === -1) return { provider: "", model: id };
  return { provider: id.slice(0, idx), model: id.slice(idx + 1) };
}