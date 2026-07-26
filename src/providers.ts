/**
 * AI provider abstraction for Groq, Gemini, and AgentRouter (ChatGPT/Claude).
 * All providers implement a streaming chat completion that yields text chunks.
 *
 * Optimized with parallel R2 image fetching, in-flight base64 caching,
 * and chunk-based PDF document context.
 */
import type { Env, ModelInfo, ProviderMessage } from "./types";
export type { ProviderMessage };
import { getMergedModels, parseModelId } from "./types";

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
  const mergedModels = await getMergedModels(env);
  const model = mergedModels.find((m) => m.id === modelId);
  if (!model) throw new Error("Unknown model: " + modelId);

  switch (model.provider) {
    case "groq":
      return streamGroq(model, messages, env, cb);
    case "gemini":
      return streamGemini(model, messages, env, cb);
    case "agentrouter":
      return streamAgentRouter(model, messages, env, cb);
    case "openrouter":
      return streamOpenRouter(model, messages, env, cb);
    case "workers-ai":
      return streamWorkersAI(model, messages, env, cb);
    default:
      throw new Error("Unsupported provider: " + model.provider);
  }
}

/* ----------------------------- Image Generation (free tier) ----------------------------- */

export interface ImageGenResult {
  b64_json: string;
  media_type: string;
}

/**
 * Generate an image using the appropriate provider.
 * Accepts optional inputReferences for image-to-image editing (img2img).
 */
export async function generateImage(
  modelId: string,
  prompt: string,
  env: Env,
  inputReferences?: { type: string; image_url: { url: string } }[]
): Promise<ImageGenResult[]> {
  const mergedModels = await getMergedModels(env);
  const model = mergedModels.find((m) => m.id === modelId);
  if (!model) throw new Error("Unknown model: " + modelId);
  if (!model.supportsImageGen) throw new Error("Model does not support image generation: " + modelId);

  switch (model.provider) {
    case "openrouter":
      return generateOpenRouterImage(prompt, modelId, env, inputReferences);
    case "workers-ai":
      return generateWorkersAIImage(prompt, modelId, env);
    default:
      throw new Error("Image generation not supported for provider: " + model.provider);
  }
}

/**
 * Generate image via OpenRouter's dedicated image API (free tier models).
 * POST https://openrouter.ai/api/v1/images
 *
 * Supports:
 * - Text-to-image (no inputReferences)
 * - Image-to-image / editing / variations (with inputReferences)
 */
async function generateOpenRouterImage(
  prompt: string,
  modelId: string,
  env: Env,
  inputReferences?: { type: string; image_url: { url: string } }[]
): Promise<ImageGenResult[]> {
  const { model: apiModel } = parseModelId(modelId);
  const url = "https://openrouter.ai/api/v1/images";

  const payload: Record<string, unknown> = {
    model: apiModel,
    prompt,
    n: 1,
  };

  // If input references are provided, pass them to enable img2img editing
  if (inputReferences && inputReferences.length > 0) {
    payload.input_references = inputReferences;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.OPENROUTER_API_KEY,
      "HTTP-Referer": "https://chatddb.pages.dev",
      "X-Title": "ChatDDB",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    if (res.status === 429) {
      throw new Error(
        "OpenRouter image generation rate limit exceeded. Please wait and try again."
      );
    }
    if (res.status === 402) {
      throw new Error(
        "OpenRouter: insufficient credits or this image model is not free with your provider."
      );
    }
    throw new Error(
      "OpenRouter image generation service unavailable (" +
        res.status +
        "): " + txt.slice(0, 200)
    );
  }

  const data = (await res.json()) as { data?: { b64_json?: string; media_type?: string }[] };
  if (!data.data || data.data.length === 0) {
    throw new Error("OpenRouter image generation returned no images.");
  }

  return data.data.map((img) => ({
    b64_json: img.b64_json || "",
    media_type: img.media_type || "image/png",
  }));
}

/**
 * Generate image via Cloudflare Workers AI (free daily quota).
 * Uses env.AI.run() with text-to-image models like @cf/black-forest-labs/flux-1-schnell.
 */
async function generateWorkersAIImage(
  prompt: string,
  modelId: string,
  env: Env
): Promise<ImageGenResult[]> {
  const { model: apiModel } = parseModelId(modelId);

  let response: ArrayBuffer | ReadableStream;
  try {
    // Workers AI image models return binary image data directly
    const result = await env.AI.run(apiModel, { prompt });

    if (result instanceof ReadableStream) {
      // Collect the stream into an ArrayBuffer
      const reader = result.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total = chunks.reduce((acc, c) => acc + c.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      response = merged.buffer as ArrayBuffer;
    } else if (result instanceof ArrayBuffer) {
      response = result;
    } else if (result && typeof result === "object" && "image" in result) {
      // Some models return { image: ArrayBuffer }
      const buf = (result as { image: ArrayBuffer }).image;
      if (buf instanceof ArrayBuffer) {
        response = buf;
      } else {
        throw new Error("Unexpected Workers AI image response format");
      }
    } else {
      throw new Error("Unexpected Workers AI image response type: " + typeof result);
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (
      msg.includes("429") ||
      msg.includes("quota") ||
      msg.includes("limit") ||
      msg.includes("neuron")
    ) {
      throw new Error(
        "Cloudflare Workers AI daily free quota (10,000 neurons) may be exhausted. " +
          "Please wait until tomorrow or select a different model. " +
          "Contact the developer if this persists."
      );
    }
    throw new Error(
      "Workers AI image generation failed: " + msg +
        ". Please try again later or contact the developer."
    );
  }

  const b64_json = arrayBufferToBase64(response);
  return [
    {
      b64_json,
      media_type: "image/png",
    },
  ];
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

/* ----------------------------- AgentRouter (OpenAI-compatible: ChatGPT, Kimi, Claude) ----------------------------- */

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

/* ----------------------------- OpenRouter (OpenAI-compatible, free tier) ----------------------------- */

async function streamOpenRouter(
  model: ModelInfo,
  messages: ProviderMessage[],
  env: Env,
  cb: StreamCallbacks
): Promise<string> {
  const { model: apiModel } = parseModelId(model.id);
  const url = "https://openrouter.ai/api/v1/chat/completions";

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
      Authorization: "Bearer " + env.OPENROUTER_API_KEY,
      "HTTP-Referer": "https://chatddb.pages.dev",
      "X-Title": "ChatDDB",
    },
    body: JSON.stringify(payload),
    signal: cb.signal,
  });

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    if (res.status === 429) {
      throw new Error(
        "OpenRouter rate limit exceeded. Please wait a moment and try again."
      );
    }
    if (res.status === 402) {
      throw new Error(
        "OpenRouter: insufficient credits or this model is not free with your provider."
      );
    }
    throw new Error(
      "OpenRouter service unavailable (" +
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

/* ----------------------------- Workers AI (Cloudflare edge inference) ----------------------------- */

async function streamWorkersAI(
  model: ModelInfo,
  messages: ProviderMessage[],
  env: Env,
  cb: StreamCallbacks
): Promise<string> {
  const { model: apiModel } = parseModelId(model.id);

  // Build messages array for Workers AI (OpenAI-compatible message format)
  const workersMessages = messages.map((m) => {
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
  });

  let stream: ReadableStream;
  try {
    const result = await env.AI.run(apiModel, {
      messages: workersMessages,
      stream: true,
    });

    // Runtime guard: ensure we got a ReadableStream back (not a non-stream response)
    if (!(result instanceof ReadableStream)) {
      throw new Error(
        "Workers AI did not return a stream. This model may not support streaming."
      );
    }
    stream = result;
  } catch (err) {
    const msg = (err as Error).message;
    if (
      msg.includes("429") ||
      msg.includes("quota") ||
      msg.includes("limit") ||
      msg.includes("neuron")
    ) {
      throw new Error(
        "Cloudflare Workers AI daily free quota (10,000 neurons) may be exhausted. " +
          "Please wait until tomorrow or select a different model. " +
          "Contact the developer if this persists."
      );
    }
    if (
      msg.includes("not found") ||
      msg.includes("model") ||
      msg.includes("unavailable")
    ) {
      throw new Error(
        "The selected Workers AI model is not available. " +
          "Please try a different model. Contact the developer if this persists."
      );
    }
    throw new Error(
      "Cloudflare Workers AI service error: " + msg +
        ". Please try again later or contact the developer."
    );
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Attempt to parse newline-delimited JSON from the buffer
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;

      try {
        const json = JSON.parse(line);
        const delta = json.response || "";
        if (delta) {
          full += delta;
          cb.onChunk(delta);
        }
      } catch {
        // Partial JSON — keep buffering
      }
    }
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    try {
      const json = JSON.parse(buffer.trim());
      const delta = json.response || "";
      if (delta) {
        full += delta;
        cb.onChunk(delta);
      }
    } catch {
      // ignore
    }
  }

  return full;
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
