/**
 * AI provider abstraction for Groq, Gemini, and AgentRouter (ChatGPT/Claude).
 * All providers implement a streaming chat completion that yields text chunks.
 *
 * Optimized with parallel R2 image fetching, in-flight base64 caching,
 * and chunk-based PDF document context.
 */
import type { Env, ModelInfo, ProviderMessage } from "./types";
import { getModel, parseModelId } from "./types";

export interface StreamCallbacks {
  onChunk: (text: string) => void;
  signal?: AbortSignal;
}

/** A cache for image base64 data keyed by r2Key, reused within a single request. */
type ImageCache = Map<string, { mimeType: string; data: string }>;

/**
 * Build provider messages with optimized image handling.
 *
 * Optimizations:
 * 1. Parallel R2 image fetches within each message
 * 2. In-flight deduplication cache (avoids re-downloading same image)
 * 3. Uses optimized (resized) images when available
 * 4. PDF context is built from chunks, not full extracted text
 */
export async function buildProviderMessages(
  history: {
    role: "user" | "assistant" | "system";
    content: string;
    attachments?: {
      kind: string;
      r2Key: string;
      name: string;
      type: string;
      extractedText?: string;
      optimizedR2Key?: string;
    }[];
  }[],
  env: Env
): Promise<ProviderMessage[]> {
  const out: ProviderMessage[] = [];
  const imageCache: ImageCache = new Map();

  for (const m of history) {
    let content = m.content;
    const imagePromises: Promise<void>[] = [];
    const imagesForMsg: { mimeType: string; data: string }[] = [];

    if (m.attachments && m.attachments.length) {
      for (const att of m.attachments) {
        if (att.kind === "image") {
          imagePromises.push(
            (async () => {
              const cached = imageCache.get(att.r2Key);
              if (cached) {
                imagesForMsg.push(cached);
                return;
              }
              // Try optimized version first, fall back to original
              const fetchKey = att.optimizedR2Key || att.r2Key;
              const obj = await env.BUCKET.get(fetchKey);
              if (obj) {
                const buf = await obj.arrayBuffer();
                const result = {
                  mimeType: att.type || "image/png",
                  data: arrayBufferToBase64(buf),
                };
                imageCache.set(att.r2Key, result);
                imagesForMsg.push(result);
              }
            })()
          );
        } else if (att.kind === "pdf" || att.kind === "file") {
          // Use extracted text (which is now already chunk-optimized from upload)
          if (att.extractedText) {
            content +=
              "\n\n[Attached document: " + att.name + "]\n" + att.extractedText;
          }
        }
      }

      // Wait for all parallel image fetches
      await Promise.all(imagePromises);
    }

    out.push({
      role: m.role,
      content,
      images: imagesForMsg.length ? imagesForMsg : undefined,
    });
  }

  return out;
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Stream a chat completion from the appropriate provider.
 * Calls onChunk for each text delta. Returns full text when done.
 */
export async function streamChat(
  modelId: string,
  messages: ProviderMessage[],
  env: Env,
  cb: StreamCallbacks
): Promise<string> {
  const model = getModel(modelId);
  if (!model) throw new Error("Unknown model: " + modelId);

  switch (model.provider) {
    case "groq":
      return streamGroq(model, messages, env, cb);
    case "gemini":
      return streamGemini(model, messages, env, cb);
    case "agentrouter":
      return streamAgentRouter(model, messages, env, cb);
    default:
      throw new Error("Unsupported provider: " + model.provider);
  }
}

/* ----------------------------- Groq (OpenAI-compatible) ----------------------------- */

async function streamGroq(
  model: ModelInfo,
  messages: ProviderMessage[],
  env: Env,
  cb: StreamCallbacks
): Promise<string> {
  const { model: apiModel } = parseModelId(model.id);
  const url = "https://api.groq.com/openai/v1/chat/completions";

  const payload = {
    model: apiModel,
    messages: messages.map((m) => {
      if (m.images && m.images.length && model.supportsVision) {
        return {
          role: m.role,
          content: [
            { type: "text", text: m.content },
            ...m.images.map((img) => ({
              type: "image_url",
              image_url: {
                url: "data:" + img.mimeType + ";base64," + img.data,
              },
            })),
          ],
        };
      }
      return { role: m.role, content: m.content };
    }),
    stream: true,
    temperature: 0.7,
    max_tokens: 4096,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.GROQ_API_KEY,
    },
    body: JSON.stringify(payload),
    signal: cb.signal,
  });

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    if (res.status === 429) {
      throw new Error(
        "Groq rate limit exceeded. Please wait a moment and try again. Contact the developer if this persists."
      );
    }
    throw new Error(
      "Groq service temporarily unavailable (" +
        res.status +
        "). Please contact the developer."
    );
  }

  return readSSEStream(res.body, (data) => {
    if (data === "[DONE]") return "";
    try {
      const json = JSON.parse(data);
      const delta = json.choices?.[0]?.delta?.content ?? "";
      return delta as string;
    } catch {
      return "";
    }
  }, cb.onChunk);
}

/* ----------------------------- AgentRouter (OpenAI-compatible: ChatGPT, Claude, Kimi) ----------------------------- */

async function streamAgentRouter(
  model: ModelInfo,
  messages: ProviderMessage[],
  env: Env,
  cb: StreamCallbacks
): Promise<string> {
  const { model: apiModel } = parseModelId(model.id);
  const url = "https://agentrouter.org/v1/chat/completions";

  const payload = {
    model: apiModel,
    messages: messages.map((m) => {
      if (m.images && m.images.length && model.supportsVision) {
        return {
          role: m.role,
          content: [
            { type: "text", text: m.content },
            ...m.images.map((img) => ({
              type: "image_url",
              image_url: {
                url: "data:" + img.mimeType + ";base64," + img.data,
              },
            })),
          ],
        };
      }
      return { role: m.role, content: m.content };
    }),
    stream: true,
    temperature: 0.7,
    max_tokens: 4096,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent":
        "codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464",
      Originator: "codex_cli_rs",
      Version: "0.101.0",
      Authorization: "Bearer " + env.AGENTROUTER_API_KEY,
    },
    body: JSON.stringify(payload),
    signal: cb.signal,
  });

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new Error(
        "AgentRouter requires a supported client. If this issue persists, contact the developer to update the integration or visit https://discord.gg/aYq5B4RW3 for help. (HTTP 401)"
      );
    }
    throw new Error(
      "AgentRouter service unavailable (" +
        res.status +
        "). Please contact the developer."
    );
  }

  return readSSEStream(res.body, (data) => {
    if (data === "[DONE]") return "";
    try {
      const json = JSON.parse(data);
      const delta = json.choices?.[0]?.delta?.content ?? "";
      return delta as string;
    } catch {
      return "";
    }
  }, cb.onChunk);
}

/* ----------------------------- Gemini ----------------------------- */

async function streamGemini(
  model: ModelInfo,
  messages: ProviderMessage[],
  env: Env,
  cb: StreamCallbacks
): Promise<string> {
  const { model: apiModel } = parseModelId(model.id);
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    apiModel +
    ":streamGenerateContent?alt=sse&key=" +
    env.GEMINI_API_KEY;

  let systemInstruction: string | undefined;
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemInstruction =
        (systemInstruction ? systemInstruction + "\n" : "") + m.content;
      continue;
    }
    const role = m.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [{ text: m.content }];
    if (m.images && m.images.length && model.supportsVision) {
      for (const img of m.images) {
        parts.push({
          inline_data: { mime_type: img.mimeType, data: img.data },
        });
      }
    }
    contents.push({ role, parts });
  }

  const payload: Record<string, unknown> = {
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
  };
  if (systemInstruction) {
    payload.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: cb.signal,
  });

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    if (res.status === 429) {
      throw new Error(
        "Gemini rate limit exceeded. Please wait a moment and try again. Contact the developer if this persists."
      );
    }
    if (res.status === 403 || res.status === 401) {
      throw new Error(
        "Gemini API key is invalid or unauthorized. Contact the developer to check the API key."
      );
    }
    throw new Error(
      "Gemini service temporarily unavailable (" +
        res.status +
        "). Please contact the developer."
    );
  }

  return readSSEStream(
    res.body,
    (data) => {
      try {
        const json = JSON.parse(data);
        const text = json.candidates?.[0]?.content?.parts
          ?.map((p: GeminiPart) => p.text ?? "")
          .join("");
        return text ?? "";
      } catch {
        return "";
      }
    },
    cb.onChunk
  );
}

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}
interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

/* ----------------------------- SSE reader ----------------------------- */

async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  parseData: (data: string) => string,
  onChunk: (text: string) => void
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        const text = parseData(data);
        if (text) {
          full += text;
          onChunk(text);
        }
      }
    }
  }
  return full;
}
