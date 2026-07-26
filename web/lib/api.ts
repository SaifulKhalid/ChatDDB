/**
 * API client for ChatDDB Worker backend.
 *
 * In production, the Worker is deployed separately (e.g.,
 * https://prototype-chatbot.chatddb-smoke.workers.dev).
 * In development, the Worker runs locally on port 8787.
 */

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? (window as any).__CHATDDB_API_URL || window.location.origin
    : "http://localhost:8787");

// In production, NEXT_PUBLIC_API_URL must be set to the Worker URL.
// Example: https://prototype-chatbot.chatddb-smoke.workers.dev

/* ─── Types ─────────────────────────────────────────── */

export interface ModelInfo {
  id: string;
  label: string;
  provider: "groq" | "gemini" | "agentrouter" | "openrouter" | "workers-ai";
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsImageGen?: boolean;
}

export interface AttachmentMeta {
  id: string;
  name: string;
  type: string;
  size: number;
  r2Key: string;
  kind: "image" | "pdf" | "file";
  extractedText?: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
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

export interface StreamEvent {
  type: "start" | "delta" | "done" | "error" | "model_selection";
  text?: string;
  messageId?: string;
  error?: string;
  model?: string;
  label?: string;
  reason?: string;
}

export interface ImageGenResult {
  b64_json: string;
  media_type: string;
}

/* ─── Auth token ────────────────────────────────────── */

let _token: string | null = null;

export function setAuthToken(token: string | null) {
  _token = token;
}

export function getAuthToken(): string | null {
  return _token;
}

/* ─── Helpers ───────────────────────────────────────── */

async function request<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (_token) {
    headers["Authorization"] = `Bearer ${_token}`;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const snippet = text.length > 200 ? text.slice(0, 200) + "…" : text;
    throw new Error(snippet || `HTTP ${res.status}`);
  }
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`Unexpected response (HTTP ${res.status})`);
  }
  return res.json();
}

async function fetchWithToken(path: string, options?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {};
  if (_token) {
    headers["Authorization"] = `Bearer ${_token}`;
  }
  // Only set Content-Type for JSON bodies
  if (options?.body && typeof options.body === "string") {
    headers["Content-Type"] = "application/json";
  }
  return fetch(`${API_BASE}${path}`, {
    headers,
    ...options,
  });
}

/* ─── API Methods ────────────────────────────────────── */

export async function getModels(): Promise<ModelInfo[]> {
  const data = await request<{ models: ModelInfo[] }>("/api/models");
  return data.models;
}

export async function listConversations(): Promise<Conversation[]> {
  const data = await request<{ conversations: Conversation[] }>(
    "/api/conversations"
  );
  return data.conversations;
}

export async function getConversation(
  id: string
): Promise<{ conversation: Conversation; messages: ChatMessage[] }> {
  return request(`/api/conversations/${id}`);
}

export async function deleteConversation(id: string): Promise<void> {
  await fetchWithToken(`/api/conversations/${id}`, { method: "DELETE" });
}

export async function updateConversation(
  id: string,
  data: { title?: string; model?: string }
): Promise<void> {
  await fetchWithToken(`/api/conversations/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function uploadFile(
  file: File
): Promise<{ attachment: AttachmentMeta }> {
  const form = new FormData();
  form.append("file", file);
  const headers: Record<string, string> = {};
  if (_token) headers["Authorization"] = `Bearer ${_token}`;
  const res = await fetch(`${API_BASE}/api/upload`, {
    method: "POST",
    headers,
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Upload failed: HTTP ${res.status}`);
  }
  return res.json();
}

export function getFileUrl(r2Key: string): string {
  return `${API_BASE}/api/files/${encodeURIComponent(r2Key)}`;
}

/* ─── Image Generation ─────────────────────────────── */

export async function generateImage(options: {
  prompt: string;
  model?: string;
  conversationId: string;
  /** R2 key of a source image for image-to-image editing (img2img) */
  imageR2Key?: string;
  /** MIME type of the source image */
  imageMimeType?: string;
}): Promise<{ images: ImageGenResult[]; model: string; userMessageId: string; assistantMessageId: string }> {
  return request("/api/generate-image", {
    method: "POST",
    body: JSON.stringify(options),
  });
}

/* ─── Streaming Chat ────────────────────────────────── */

export function streamChat(
  conversationId: string,
  message: string,
  model: string,
  attachments: AttachmentMeta[],
  callbacks: {
    onDelta: (text: string) => void;
    onDone: (text: string) => void;
    onError: (error: string) => void;
    onModelSelection?: (modelId: string, label: string, reason: string) => void;
  },
  abortController?: AbortController
): AbortController {
  const controller = abortController || new AbortController();

  (async () => {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (_token) headers["Authorization"] = `Bearer ${_token}`;
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          conversationId,
          message,
          attachments,
          model,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (!controller.signal.aborted) callbacks.onError(text || `HTTP ${res.status}`);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        if (!controller.signal.aborted) callbacks.onError("No response body");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done || controller.signal.aborted) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = chunk.trim();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;

          try {
            const evt = JSON.parse(data) as StreamEvent;
            if (evt.type === "delta" && evt.text) {
              callbacks.onDelta(evt.text);
            } else if (evt.type === "done") {
              callbacks.onDone(evt.text || "");
            } else if (evt.type === "error") {
              callbacks.onError(evt.error || "Unknown error");
            } else if (evt.type === "model_selection" && evt.model && callbacks.onModelSelection) {
              callbacks.onModelSelection(
                evt.model,
                evt.label || evt.model,
                evt.reason || ""
              );
            }
          } catch {
            // skip parse errors
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        callbacks.onError((err as Error).message || "Connection error");
      }
    }
  })();

  return controller;
}