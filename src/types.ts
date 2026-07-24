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
  // --- Groq (free tier, fastest inference) ---
  {
    id: "groq:llama-3.3-70b-versatile",
    label: "Groq Llama 3.3 70B",
    provider: "groq",
    supportsVision: false,
    supportsStreaming: true,
  },
  {
    id: "groq:llama-3.1-8b-instant",
    label: "Groq Llama 3.1 8B (Fast)",
    provider: "groq",
    supportsVision: false,
    supportsStreaming: true,
  },
  {
    id: "groq:llama-3.2-11b-vision-preview",
    label: "Groq Llama 3.2 Vision",
    provider: "groq",
    supportsVision: true,
    supportsStreaming: true,
  },

  // --- Gemini (free tier, Google AI) ---
  {
    id: "gemini:gemini-2.0-flash",
    label: "Gemini 2.0 Flash",
    provider: "gemini",
    supportsVision: true,
    supportsStreaming: true,
  },
  {
    id: "gemini:gemini-2.5-flash",
    label: "Gemini 2.5 Flash Pro",
    provider: "gemini",
    supportsVision: true,
    supportsStreaming: true,
  },

  // --- AgentRouter (gateway to ChatGPT & Claude) ---
  {
    id: "agentrouter:gpt-5.5",
    label: "AgentRouter ChatGPT",
    provider: "agentrouter",
    supportsVision: true,
    supportsStreaming: true,
  },
  {
    id: "agentrouter:claude-opus-4-6",
    label: "AgentRouter Claude",
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