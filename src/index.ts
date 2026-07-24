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
import { extractPdfText, classifyAttachment } from "./pdf";
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
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

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
        return uploadFile(req, env);
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
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
        await env.BUCKET.delete(a.r2Key);
      }
    } catch {
      // ignore parse errors
    }
  }
  await env.DB.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM conversations WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

/* ----------------------------- Upload ----------------------------- */

async function uploadFile(req: Request, env: Env): Promise<Response> {
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

  await env.BUCKET.put(r2Key, buf, {
    httpMetadata: { contentType: type },
    customMetadata: { originalName: name, uploadedAt: new Date().toISOString() },
  });

  let extractedText: string | undefined;
  if (kind === "pdf") {
    extractedText = await extractPdfText(buf);
  }

  const meta: AttachmentMeta = {
    id,
    name,
    type,
    size: file.size,
    r2Key,
    kind,
    extractedText,
  };
  return json({ attachment: meta }, 201);
}

async function serveFile(key: string, env: Env): Promise<Response> {
  // key is URL-encoded r2Key
  const r2Key = decodeURIComponent(key);
  const obj = await env.BUCKET.get(r2Key);
  if (!obj) return json({ error: "File not found" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, max-age=3600");
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
  const history = (results ?? []).map(parseMessageRow);

  // Build provider messages with a system prompt
  const systemPrompt =
    "You are a helpful, friendly AI assistant. Answer clearly and concisely. " +
    "When given images, describe and reason about them. When given PDFs, use the extracted text as context.";
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
    },
  });
}