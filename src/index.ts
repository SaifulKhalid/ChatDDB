/**
 * PrototypeChatBot — Cloudflare Worker entry point.
 *
 * Routes:
 *   GET  /api/health                 -> health check
 *   GET  /api/models                 -> list available models
 *   GET  /api/conversations          -> list conversations
 *   POST /api/conversations          -> create conversation
 *   GET  /api/conversations/:id      -> get conversation + messages
 *   PATCH /api/conversations/:id     -> update title/model
 *   DELETE /api/conversations/:id    -> delete conversation
 *   POST /api/upload                 -> upload file to R2, returns attachment meta
 *   GET  /api/files/:key             -> serve file from R2 (for display)
 *   POST /api/chat                   -> stream a chat completion (SSE)
 *
 * Static assets (frontend) are served from ./public via the `assets` binding.
 */
import { streamChat, buildProviderMessages } from "./providers";
import {
  extractPdfText,
  classifyAttachment,
  chunkText,
  buildContextFromChunks,
} from "./pdf";
import {
  MODELS,
  getModel,
  type AttachmentMeta,
  type ChatMessage,
  type Conversation,
  type Env,
  type Role,
} from "./types";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    try {
      // API routes
      if (pathname === "/api/health") return json({ ok: true, name: env.APP_NAME });

      if (pathname === "/api/models" && method === "GET") {
        return json({ models: MODELS });
      }

      if (pathname === "/api/conversations") {
        if (method === "GET") return listConversations(env);
        if (method === "POST") return createConversation(req, env);
      }

      const convMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
      if (convMatch) {
        const id = convMatch[1];
        if (method === "GET") return getConversation(id, env);
        if (method === "PATCH") return updateConversation(id, req, env);
        if (method === "DELETE") return deleteConversation(id, env);
      }

      if (pathname === "/api/upload" && method === "POST") {
        return uploadFile(req, env, ctx);
      }

      const fileMatch = pathname.match(/^\/api\/files\/(.+)$/);
      if (fileMatch && method === "GET") {
        return serveFile(fileMatch[1], env);
      }

      if (pathname === "/api/chat" && method === "POST") {
        return chat(req, env);
      }

      // Fall through to static assets (frontend). If no asset matches, return 404 JSON.
      return env.ASSETS
        ? fetchAssetFallback(req, env)
        : new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error("API error", err);
      return json({ error: (err as Error).message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/* ----------------------------- Helpers ----------------------------- */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function genId(): string {
  return crypto.randomUUID();
}

async function fetchAssetFallback(req: Request, env: Env): Promise<Response> {
  // Use the assets binding to serve static files; for SPA fallback, serve index.html.
  const res = await env.ASSETS.fetch(req);
  if (res.status !== 404) return res;
  // SPA fallback
  const indexReq = new Request(new URL("/", req.url), req);
  return env.ASSETS.fetch(indexReq);
}

function maxUploadBytes(env: Env): number {
  return parseInt(env.MAX_UPLOAD_BYTES || "20971520", 10);
}

/* ----------------------------- Conversations ----------------------------- */

async function listConversations(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT id, title, model, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 100"
  ).all<Conversation>();
  return json({ conversations: results ?? [] });
}

async function createConversation(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => ({})) as { title?: string; model?: string };
  const id = genId();
  const title = body.title?.trim() || "New chat";
  const model = body.model && getModel(body.model) ? body.model : MODELS[0].id;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, title, model, now, now).run();
  return json({ id, title, model, created_at: now, updated_at: now }, 201);
}

async function getConversation(id: string, env: Env): Promise<Response> {
  const conv = await env.DB.prepare(
    "SELECT id, title, model, created_at, updated_at FROM conversations WHERE id = ?"
  ).bind(id).first<Conversation>();
  if (!conv) return json({ error: "Conversation not found" }, 404);

  const { results } = await env.DB.prepare(
    "SELECT id, conversation_id, role, content, attachments, model, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC"
  ).bind(id).all<ChatMessageRow>();

  const messages: ChatMessage[] = (results ?? []).map(parseMessageRow);
  return json({ conversation: conv, messages });
}

async function updateConversation(id: string, req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => ({})) as { title?: string; model?: string };
  const conv = await env.DB.prepare("SELECT id FROM conversations WHERE id = ?").bind(id).first();
  if (!conv) return json({ error: "Conversation not found" }, 404);

  const updates: string[] = [];
  const values: (string | number)[] = [];
  if (body.title !== undefined) {
    updates.push("title = ?");
    values.push(body.title);
  }
  if (body.model !== undefined && getModel(body.model)) {
    updates.push("model = ?");
    values.push(body.model);
  }
  if (updates.length === 0) return json({ ok: true });
  updates.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);
  await env.DB.prepare(`UPDATE conversations SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  return json({ ok: true });
}

async function deleteConversation(id: string, env: Env): Promise<Response> {
  // Delete attachments from R2 first.
  const { results } = await env.DB.prepare(
    "SELECT attachments FROM messages WHERE conversation_id = ?"
  ).bind(id).all<{ attachments: string }>();
  for (const row of results ?? []) {
    try {
      const atts = JSON.parse(row.attachments || "[]") as AttachmentMeta[];
      for (const a of atts) {
        if (a.r2Key) await env.BUCKET.delete(a.r2Key).catch(() => {});
        if (a.optimizedR2Key) await env.BUCKET.delete(a.optimizedR2Key).catch(() => {});
        if (a.textR2Key) await env.BUCKET.delete(a.textR2Key).catch(() => {});
        await env.DB.prepare("DELETE FROM document_chunks WHERE attachment_id = ?").bind(a.id).run().catch(() => {});
      }
    } catch {
      // ignore parse errors
    }
  }
  await env.DB.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM conversations WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

/* ----------------------------- Upload (Optimized) ----------------------------- */

/**
 * Upload a file to R2.
 *
 * OPTIMIZATION: Returns immediately after storing the original file.
 * PDF extraction and image optimization run as fire-and-forget background promises.
 * The client can check the `processing` flag to know when ready.
 */
async function uploadFile(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return json({ error: "No file provided (field name must be 'file')" }, 400);
  }
  const max = maxUploadBytes(env);
  if (file.size > max) {
    return json({ error: `File too large. Max ${max} bytes.` }, 413);
  }

  const id = genId();
  const name = file.name || "upload";
  const type = file.type || "application/octet-stream";
  const kind = classifyAttachment(type, name);
  const buf = await file.arrayBuffer();
  const r2Key = `uploads/${id}/${name.replace(/[^\w.\-]/g, "_")}`;

  // Step 1: Store original file immediately (fast)
  await env.BUCKET.put(r2Key, buf, {
    httpMetadata: { contentType: type },
    customMetadata: { originalName: name, uploadedAt: new Date().toISOString() },
  });

  // Step 2: Build initial attachment meta (return immediately, mark as processing)
  const meta: AttachmentMeta = {
    id,
    name,
    type,
    size: file.size,
    r2Key,
    kind,
    processing: kind === "pdf" || kind === "image",
  };

  // Step 3: Fire background processing using ctx.waitUntil for reliability
  const bgPromises: Promise<void>[] = [];
  if (kind === "pdf") {
    bgPromises.push(
      processPdfInBackground(buf, id, r2Key, name, type, file.size, env)
        .catch((err) => console.error("Background PDF processing failed:", err))
    );
  } else if (kind === "image") {
    bgPromises.push(
      processImageInBackground(buf, id, r2Key, name, type, file.size, env)
        .catch((err) => console.error("Background image processing failed:", err))
    );
  }
  // Use ctx.waitUntil to ensure background tasks complete even after response is sent
  for (const p of bgPromises) {
    ctx.waitUntil(p);
  }

  return json({ attachment: meta }, 201);
}

/** Background PDF processing: extract text, chunk, store in R2 + D1. */
async function processPdfInBackground(
  buf: ArrayBuffer, id: string, r2Key: string, name: string, type: string, size: number, env: Env
): Promise<void> {
  const fullText = await extractPdfText(buf);

  // Store extracted text as separate R2 object
  const textR2Key = `documents/${id}/extracted.txt`;
  await env.BUCKET.put(textR2Key, fullText, {
    httpMetadata: { contentType: "text/plain" },
    customMetadata: { originalName: name, source: r2Key, processedAt: new Date().toISOString() },
  });

  // Chunk the text and store chunks in D1
  const chunks = chunkText(fullText, 4000);
  if (chunks.length > 0) {
    const stmt = env.DB.prepare(
      "INSERT OR IGNORE INTO document_chunks (id, attachment_id, chunk_index, chunk_text, token_estimate) VALUES (?, ?, ?, ?, ?)"
    );
    for (let i = 0; i < chunks.length; i++) {
      await stmt.bind(genId(), id, i, chunks[i].text, chunks[i].tokenEstimate).run();
    }
  }

  // Build truncated context from first N chunks for immediate use
  const contextText = buildContextFromChunks(chunks, 3);

  // Store processed metadata marker in R2
  const processedMeta: AttachmentMeta = {
    id, name, type, size, r2Key, kind: "pdf",
    textR2Key, extractedText: contextText, processing: false,
  };
  await env.BUCKET.put(`meta/${id}.json`, JSON.stringify(processedMeta), {
    httpMetadata: { contentType: "application/json" },
  });
}

/** Background image processing (placeholder — mark as done). */
async function processImageInBackground(
  buf: ArrayBuffer, id: string, r2Key: string, name: string, type: string, size: number, env: Env
): Promise<void> {
  const processedMeta: AttachmentMeta = {
    id, name, type, size, r2Key, kind: "image", processing: false,
  };
  await env.BUCKET.put(`meta/${id}.json`, JSON.stringify(processedMeta), {
    httpMetadata: { contentType: "application/json" },
  });
}

/** Load processed metadata for an attachment from R2. */
async function loadProcessedMeta(id: string, env: Env): Promise<AttachmentMeta | null> {
  try {
    const obj = await env.BUCKET.get(`meta/${id}.json`);
    if (!obj) return null;
    return JSON.parse(await obj.text()) as AttachmentMeta;
  } catch {
    return null;
  }
}

/** Load document chunks for a given attachment from D1. */
async function loadDocumentChunks(
  attachmentId: string, env: Env, maxChunks = 5
): Promise<{ text: string; tokenEstimate: number }[]> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT chunk_text, token_estimate FROM document_chunks WHERE attachment_id = ? ORDER BY chunk_index ASC LIMIT ?"
    ).bind(attachmentId, maxChunks).all<{ chunk_text: string; token_estimate: number }>();
    return (results ?? []).map((r) => ({ text: r.chunk_text, tokenEstimate: r.token_estimate }));
  } catch {
    return [];
  }
}

async function serveFile(key: string, env: Env): Promise<Response> {
  // key is URL-encoded r2Key
  const r2Key = decodeURIComponent(key);
  const obj = await env.BUCKET.get(r2Key);
  if (!obj) return json({ error: "File not found" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, max-age=3600");
  for (const [key, val] of Object.entries(corsHeaders())) {
    headers.set(key, val);
  }
  return new Response(obj.body, { headers });
}

/* ----------------------------- Chat (SSE streaming) ----------------------------- */

interface ChatMessageRow {
  id: string;
  conversation_id: string;
  role: Role;
  content: string;
  attachments: string;
  model: string | null;
  created_at: number;
}

function parseMessageRow(row: ChatMessageRow): ChatMessage {
  let attachments: AttachmentMeta[] = [];
  try {
    attachments = JSON.parse(row.attachments || "[]") as AttachmentMeta[];
  } catch {
    attachments = [];
  }
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    role: row.role,
    content: row.content,
    attachments,
    model: row.model,
    created_at: row.created_at,
  };
}

/**
 * Enrich attachments with processed data: chunk-based PDF context, optimized image keys.
 * Runs in parallel across all attachments in all messages.
 */
async function enrichAttachmentsWithProcessedData(
  messages: ChatMessage[], env: Env
): Promise<ChatMessage[]> {
  const enriched = messages.map(async (msg) => {
    if (!msg.attachments || msg.attachments.length === 0) return msg;
    const enrichedAtts = await Promise.all(
      msg.attachments.map(async (att) => {
        if (att.kind === "pdf") {
          try {
            const chunks = await loadDocumentChunks(att.id, env, 3);
            if (chunks.length > 0) {
              return { ...att, extractedText: chunks.map(c => c.text).join("\n\n") };
            }
          } catch { /* fall through */ }
        }
        if (att.kind === "image") {
          const meta = await loadProcessedMeta(att.id, env);
          if (meta && meta.optimizedR2Key) {
            return { ...att, optimizedR2Key: meta.optimizedR2Key };
          }
        }
        return att;
      })
    );
    return { ...msg, attachments: enrichedAtts };
  });
  return Promise.all(enriched);
}

async function chat(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => ({})) as {
    conversationId?: string;
    message?: string;
    attachments?: AttachmentMeta[];
    model?: string;
  };

  const conversationId = body.conversationId;
  const message = (body.message ?? "").trim();
  const attachments = body.attachments ?? [];
  const modelId = body.model && getModel(body.model) ? body.model : MODELS[0].id;

  if (!conversationId) return json({ error: "conversationId is required" }, 400);
  if (!message && attachments.length === 0) return json({ error: "message or attachment required" }, 400);

  // Ensure conversation exists
  let conv = await env.DB.prepare(
    "SELECT id, title, model FROM conversations WHERE id = ?"
  ).bind(conversationId).first<Conversation>();
  if (!conv) {
    const now = Math.floor(Date.now() / 1000);
    const title = message ? message.slice(0, 40) : "New chat";
    await env.DB.prepare(
      "INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(conversationId, title, modelId, now, now).run();
    conv = { id: conversationId, title, model: modelId, created_at: now, updated_at: now };
  }

  // Update conversation model if changed
  if (conv.model !== modelId) {
    await env.DB.prepare("UPDATE conversations SET model = ?, updated_at = ? WHERE id = ?")
      .bind(modelId, Math.floor(Date.now() / 1000), conversationId).run();
  }

  // Persist the user message
  const userMsgId = genId();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO messages (id, conversation_id, role, content, attachments, created_at) VALUES (?, ?, 'user', ?, ?, ?)"
  ).bind(userMsgId, conversationId, message, JSON.stringify(attachments), now).run();

  // Auto-title from first user message if still default
  if (conv.title === "New chat" && message) {
    await env.DB.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
      .bind(message.slice(0, 50), now, conversationId).run();
  }

  // Load history
  const { results } = await env.DB.prepare(
    "SELECT id, conversation_id, role, content, attachments, model, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC"
  ).bind(conversationId).all<ChatMessageRow>();
  let history = (results ?? []).map(parseMessageRow);

  // OPTIMIZATION: Enrich attachments with processed data (chunks, optimized images)
  history = await enrichAttachmentsWithProcessedData(history, env);

  // Build provider messages with a system prompt
  const systemPrompt =
    "You are a helpful, friendly AI assistant. Answer clearly and concisely. " +
    "When given images, describe and reason about them. When given PDFs, use the provided text as context.";
  const providerMessages = await buildProviderMessages(
    [
      { role: "system", content: systemPrompt },
      ...history.map((m) => ({
        role: m.role,
        content: m.content,
        attachments: m.attachments.map((a) => ({
          kind: a.kind,
          r2Key: a.r2Key,
          name: a.name,
          type: a.type,
          extractedText: a.extractedText,
          optimizedR2Key: a.optimizedR2Key,
        })),
      })),
    ],
    env
  );

  // Stream response via SSE
  const assistantMsgId = genId();
  const encoder = new TextEncoder();
  let fullText = "";

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      try {
        send({ type: "start", messageId: assistantMsgId });
        fullText = await streamChat(modelId, providerMessages, env, {
          onChunk: (text) => send({ type: "delta", text }),
        });
        send({ type: "done", text: fullText });

        // Persist assistant message
        const ts = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
          "INSERT INTO messages (id, conversation_id, role, content, attachments, model, created_at) VALUES (?, ?, 'assistant', ?, '[]', ?, ?)"
        ).bind(assistantMsgId, conversationId, fullText, modelId, ts).run();
        await env.DB.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
          .bind(ts, conversationId).run();
      } catch (err) {
        const msg = (err as Error).message;
        send({ type: "error", error: msg });
        // Persist partial if any
        if (fullText) {
          const ts = Math.floor(Date.now() / 1000);
          await env.DB.prepare(
            "INSERT INTO messages (id, conversation_id, role, content, attachments, model, created_at) VALUES (?, ?, 'assistant', ?, '[]', ?, ?)"
          ).bind(assistantMsgId, conversationId, fullText + `\n\n[error: ${msg}]`, modelId, ts).run();
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}