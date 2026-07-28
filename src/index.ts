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
 * Static assets (frontend) are served from web/out via the ASSETS binding.
 */
import { jwtVerify, createRemoteJWKSet } from "jose";
import { streamChat, buildProviderMessages, generateImage, arrayBufferToBase64, type ProviderMessage } from "./providers";
import {
  extractPdfText,
  classifyAttachment,
  chunkText,
  buildContextFromChunks,
} from "./pdf";
import {
  MODELS,
  getMergedModels,
  parseModelId,
  type AttachmentMeta,
  type ChatMessage,
  type Conversation,
  type Env,
  type ModelSelection,
  type Role,
} from "./types";
import {
  selectAutoModel,
  selectFallbackModel,
  selectAutoImageModel,
  selectFallbackImageModel,
} from "./auto-selector";
import { healthTracker } from "./health-tracker";
import {
  checkRateLimit,
  rateLimitIdentifier,
  checkGuestQuota,
  getGuestUsage,
  incrementGuestUsage,
} from "./rate-limiting";

/* ─── Firebase JWT Verification ─────────────────────── */

const JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
);

interface FirebaseUser {
  uid: string;
  email: string;
  name: string;
  picture: string;
}

/** Verify a Firebase ID token from the Authorization header. */
async function verifyAuth(req: Request, env: Env): Promise<FirebaseUser | null> {
  const auth = req.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
    });
    return { uid: payload.sub as string, email: (payload.email as string) || "", name: (payload.name as string) || "", picture: (payload.picture as string) || "" };
  } catch { return null; }
}

/** Require auth; returns 401 if not authenticated, 403 if disabled. */
async function requireAuth(req: Request, env: Env): Promise<FirebaseUser | Response> {
  const user = await verifyAuth(req, env);
  if (!user) return json({ error: "Authentication required. Please sign in." }, 401);

  // Check if account is disabled
  try {
    const profile = await env.DB.prepare(
      "SELECT is_disabled FROM user_profiles WHERE uid = ?"
    ).bind(user.uid).first<{ is_disabled: number }>();
    if (profile?.is_disabled === 1) {
      return json({ error: "Account disabled. Please contact the administrator." }, 403);
    }
  } catch {
    // If DB query fails, allow through (better than locking everyone out)
  }

  return user;
}

/** Upsert user profile on every login. */
async function upsertUserProfile(user: FirebaseUser, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO user_profiles (uid, email, display_name, photo_url, last_sign_in, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET email=excluded.email, display_name=excluded.display_name, photo_url=excluded.photo_url, last_sign_in=excluded.last_sign_in`
  ).bind(user.uid, user.email, user.name, user.picture, now, now).run();
}

/** Check if a user's email is in the admin allowlist. */
async function isAdmin(user: FirebaseUser, env: Env): Promise<boolean> {
  if (!user.email) return false;
  const row = await env.DB.prepare("SELECT 1 FROM admin_emails WHERE email = ?").bind(user.email).first();
  return row !== null;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      // Public routes (no auth required)
      if (pathname === "/api/health") return json({ ok: true, name: env.APP_NAME });
      if (pathname === "/api/models" && method === "GET") {
        return json({ models: await getMergedModels(env) });
      }

      // File serving — publicly accessible via unguessable UUID keys (no auth needed)
      const fileMatch = pathname.match(/^\/api\/files\/(.+)$/);
      if (fileMatch && method === "GET") return serveFile(fileMatch[1], env);

      // Auth routes (verify token, no session needed)
      if (pathname === "/api/auth/login" && method === "POST") {
        const user = await verifyAuth(req, env);
        if (!user) return json({ error: "Invalid token" }, 401);
        await upsertUserProfile(user, env);
        return json({ user: { uid: user.uid, email: user.email, name: user.name, picture: user.picture } });
      }
      if (pathname === "/api/auth/me" && method === "GET") {
        const user = await verifyAuth(req, env);
        if (!user) return json({ error: "Not authenticated" }, 401);
        await upsertUserProfile(user, env);
        return json({ user: { ...user, isAdmin: await isAdmin(user, env) } });
      }

      // All remaining API routes require authentication
      const authResult = await requireAuth(req, env);
      if (authResult instanceof Response) return authResult;
      const user: FirebaseUser = authResult;
      ctx.waitUntil(upsertUserProfile(user, env));

      // Check if guestClientId was provided even for authenticated users (ignore)
      // Only unauthenticated requests pass through guestClientId

      // Admin-only routes
      if (pathname.startsWith("/api/admin/")) {
        if (!(await isAdmin(user, env))) return json({ error: "Admin access required." }, 403);
      }

      // Admin user management
      const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (pathname === "/api/admin/users" && method === "GET") return adminListAllUsers(env);
      if (adminUserMatch && method === "GET") return adminGetUserConversations(adminUserMatch[1], env);

      // Admin model management
      if (pathname === "/api/admin/models") {
        if (method === "GET") return adminListModels(env);
        if (method === "POST") return adminAddModel(req, env);
        if (method === "DELETE") return adminDeleteModel(req, env);
        if (method === "PUT") return adminUpdateModel(req, env);
      }

      // Authenticated user routes
      if (pathname === "/api/conversations") {
        if (method === "GET") return listConversations(user.uid, env);
        if (method === "POST") return createConversation(req, user.uid, env);
      }

      const convMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
      if (convMatch) {
        const id = convMatch[1];
        if (method === "GET") return getConversation(id, user.uid, env);
        if (method === "PATCH") return updateConversation(id, req, user.uid, env);
        if (method === "DELETE") return deleteConversation(id, user.uid, env);
      }

      if (pathname === "/api/upload" && method === "POST") {
        // Backend guest quota check (read from header to avoid consuming the body)
        const guestClientId = req.headers.get("X-Guest-Client-Id") || undefined;
        const guestCheck = await checkGuestQuota(guestClientId, "upload", env);
        if (guestCheck) return guestCheck;
        return uploadFile(req, env, ctx);
      }

      // Rate limiting for authenticated routes (guest rate limits use same identifier)
      const rlIdent = rateLimitIdentifier(req, user);
      const rateLimitCheck = await checkRateLimit(rlIdent, pathname, env);
      if (rateLimitCheck) return rateLimitCheck;

      // Protect /api/test-openrouter behind feature flag
      if (pathname === "/api/test-openrouter" && method === "GET") {
        if (env.ENABLE_TEST_OPENROUTER !== "true") {
          return json({ error: "This endpoint is disabled.", code: "ENDPOINT_DISABLED" }, 404);
        }
        return testOpenRouterFreeModels(env);
      }

      if (pathname === "/api/chat" && method === "POST") {
        // Backend guest quota check (read from header to avoid consuming the body)
        const guestClientId = req.headers.get("X-Guest-Client-Id") || undefined;
        const guestCheck = await checkGuestQuota(guestClientId, "chat", env);
        if (guestCheck) return guestCheck;
        return chat(req, user, env, ctx);
      }
      if (pathname === "/api/enhance" && method === "POST") return enhancePrompt(req, env);
      if (pathname === "/api/generate-image" && method === "POST") {
        const guestClientId = req.headers.get("X-Guest-Client-Id") || undefined;
        const guestCheck = await checkGuestQuota(guestClientId, "image_gen", env);
        if (guestCheck) return guestCheck;
        return handleGenerateImage(req, user, env, ctx);
      }

      // Catch-all: SPA fallback or 404
      return env.ASSETS ? fetchAssetFallback(req, env) : new Response("Not Found", { status: 404 });
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
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, PUT, OPTIONS",
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

async function listConversations(userId: string, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT id, title, model, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100"
  ).bind(userId).all<Conversation>();
  return json({ conversations: results ?? [] });
}

async function createConversation(req: Request, userId: string, env: Env): Promise<Response> {
  const body = await req.json().catch(() => ({})) as { title?: string; model?: string };
  const id = genId();
  const title = body.title?.trim() || "New chat";
  const mergedModels = await getMergedModels(env);
  const model = body.model && mergedModels.some((m) => m.id === body.model) ? body.model : mergedModels[0]?.id || MODELS[0].id;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO conversations (id, user_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, userId, title, model, now, now).run();
  return json({ id, title, model, created_at: now, updated_at: now }, 201);
}

async function getConversation(id: string, userId: string, env: Env): Promise<Response> {
  const conv = await env.DB.prepare(
    "SELECT id, user_id, title, model, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?"
  ).bind(id, userId).first<Conversation>();
  if (!conv) return json({ error: "Conversation not found" }, 404);

  const { results } = await env.DB.prepare(
    "SELECT id, conversation_id, role, content, attachments, model, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC"
  ).bind(id).all<ChatMessageRow>();

  const messages: ChatMessage[] = (results ?? []).map(parseMessageRow);
  return json({ conversation: conv, messages });
}

async function updateConversation(id: string, req: Request, userId: string, env: Env): Promise<Response> {
  const body = await req.json().catch(() => ({})) as { title?: string; model?: string };
  const conv = await env.DB.prepare("SELECT id FROM conversations WHERE id = ? AND user_id = ?").bind(id, userId).first();
  if (!conv) return json({ error: "Conversation not found" }, 404);

  const mergedModels = await getMergedModels(env);
  const updates: string[] = [];
  const values: (string | number)[] = [];
  if (body.title !== undefined) { updates.push("title = ?"); values.push(body.title); }
  if (body.model !== undefined && (body.model === "auto" || mergedModels.some((m) => m.id === body.model))) {
    updates.push("model = ?"); values.push(body.model);
  }
  if (updates.length === 0) return json({ ok: true });
  updates.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);
  await env.DB.prepare(`UPDATE conversations SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  return json({ ok: true });
}

async function deleteConversation(id: string, userId: string, env: Env): Promise<Response> {
  const conv = await env.DB.prepare("SELECT id FROM conversations WHERE id = ? AND user_id = ?").bind(id, userId).first();
  if (!conv) return json({ error: "Conversation not found" }, 404);

  const { results } = await env.DB.prepare("SELECT attachments FROM messages WHERE conversation_id = ?").bind(id).all<{ attachments: string }>();
  for (const row of results ?? []) {
    try {
      const atts = JSON.parse(row.attachments || "[]") as AttachmentMeta[];
      for (const a of atts) {
        if (a.r2Key) await env.BUCKET.delete(a.r2Key).catch(() => {});
        if (a.optimizedR2Key) await env.BUCKET.delete(a.optimizedR2Key).catch(() => {});
        if (a.textR2Key) await env.BUCKET.delete(a.textR2Key).catch(() => {});
        await env.DB.prepare("DELETE FROM document_chunks WHERE attachment_id = ?").bind(a.id).run().catch(() => {});
      }
    } catch { /* ignore */ }
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

  // If guest upload, increment the backend quota count
  // (Read guestClientId from header to avoid consuming the form body twice)
  const guestClientId = req.headers.get("X-Guest-Client-Id");
  if (guestClientId) {
    ctx.waitUntil(incrementGuestUsage(guestClientId, "upload", env));
  }

  return json({
    attachment: meta,
    code: "UPLOAD_SUCCESS",
  }, 201);
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

async function chat(req: Request, user: FirebaseUser, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await req.json().catch(() => ({})) as {
    conversationId?: string; message?: string; attachments?: AttachmentMeta[]; model?: string;
  };

  const conversationId = body.conversationId;
  const message = (body.message ?? "").trim();
  const attachments = body.attachments ?? [];
  const mergedModels = await getMergedModels(env);
  const isAutoMode = body.model === "auto";
  let modelId: string;
  if (isAutoMode) { modelId = "auto"; }
  else if (body.model && mergedModels.some((m) => m.id === body.model)) { modelId = body.model; }
  else { modelId = mergedModels[0]?.id || MODELS[0].id; }

  if (!conversationId) return json({ error: "conversationId is required" }, 400);
  if (!message && attachments.length === 0) return json({ error: "message or attachment required" }, 400);

  // Ensure conversation exists (owned by this user)
  let conv = await env.DB.prepare(
    "SELECT id, title, model FROM conversations WHERE id = ? AND user_id = ?"
  ).bind(conversationId, user.uid).first<Conversation>();
  if (!conv) {
    const now = Math.floor(Date.now() / 1000);
    const title = message ? message.slice(0, 40) : "New chat";
    await env.DB.prepare(
      "INSERT INTO conversations (id, user_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(conversationId, user.uid, title, modelId, now, now).run();
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

  // Auto mode: intelligently select the best model based on request content
  let autoSelection: { modelId: string; provider: string; reason: string } | undefined;
  if (isAutoMode) {
    autoSelection = selectAutoModel(message, attachments, history.length, mergedModels);
    modelId = autoSelection.modelId;
  }

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
  const startTime = Date.now();
  let fullText = "";

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };

      const tryProvider = async (mId: string): Promise<string> => {
        return streamChat(mId, providerMessages, env, {
          onChunk: (text) => send({ type: "delta", text }),
        });
      };

      try {
        send({ type: "start", messageId: assistantMsgId });

        // Emit auto-selection info if in auto mode
        if (autoSelection) {
          // Derive a user-friendly label from the model ID
          const label = autoSelection.modelId.includes(":")
            ? autoSelection.modelId.split(":").pop() || autoSelection.modelId
            : autoSelection.modelId;
          send({
            type: "model_selection",
            model: autoSelection.modelId,
            label,
            reason: autoSelection.reason,
          });
        }

        // Helper to emit model_selection with same format
        const emitModelSelection = (sel: typeof autoSelection) => {
          if (!sel) return;
          const label = sel.modelId.includes(":")
            ? sel.modelId.split(":").pop() || sel.modelId
            : sel.modelId;
          send({
            type: "model_selection",
            model: sel.modelId,
            label,
            reason: sel.reason,
          });
        };

        // Attempt primary provider, with auto-fallback chain
        if (autoSelection) {
          // Auto mode: try providers in priority order until one succeeds
          let lastFailedProvider = "";
          let succeeded = false;

          while (!succeeded) {
            try {
              fullText = await tryProvider(modelId);
              healthTracker.recordSuccess(
                autoSelection.provider + ":chat",
                Date.now() - startTime
              );
              succeeded = true;
            } catch (err) {
              healthTracker.recordFailure(autoSelection.provider + ":chat");
              lastFailedProvider = autoSelection.provider;

              const fallback = selectFallbackModel(
                lastFailedProvider,
                message,
                attachments,
                history.length,
                mergedModels
              );

              if (fallback) {
                modelId = fallback.modelId;
                autoSelection = fallback;
                emitModelSelection(fallback);
              } else {
                // All compatible providers exhausted — throw friendly error
                throw new Error(
                  "All AI providers are currently unavailable. " +
                    "Please try again later. If the issue persists, contact the developer."
                );
              }
            }
          }
        } else {
          // Manual mode: single attempt, no fallback
          fullText = await tryProvider(modelId);
        }

        send({ type: "done", text: fullText });

        // Increment guest usage if applicable (read from header, body already consumed)
        const guestClientId = req.headers.get("X-Guest-Client-Id");
        if (guestClientId) {
          ctx.waitUntil(incrementGuestUsage(guestClientId, "chat", env));
        }

        // Persist assistant message with the actually selected model
        const persistModel = autoSelection ? autoSelection.modelId : modelId;
        const ts = Math.floor(Date.now() / 1000);
        await env.DB.prepare(
          "INSERT INTO messages (id, conversation_id, role, content, attachments, model, created_at) VALUES (?, ?, 'assistant', ?, '[]', ?, ?)"
        ).bind(assistantMsgId, conversationId, fullText, persistModel, ts).run();
        await env.DB.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
          .bind(ts, conversationId).run();
      } catch (err) {
        const msg = (err as Error).message;
        send({ type: "error", error: msg });
        // Persist partial if any
        if (fullText) {
          const persistModel = autoSelection ? autoSelection.modelId : modelId;
          const ts = Math.floor(Date.now() / 1000);
          await env.DB.prepare(
            "INSERT INTO messages (id, conversation_id, role, content, attachments, model, created_at) VALUES (?, ?, 'assistant', ?, '[]', ?, ?)"
          ).bind(assistantMsgId, conversationId, fullText + `\n\n[error: ${msg}]`, persistModel, ts).run();
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

/* ----------------------------- Admin: Model Management ----------------------------- */

async function adminListModels(env: Env): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT row_id, model_id, label, provider, supports_vision, supports_streaming, created_at FROM admin_models ORDER BY provider, label"
    ).all();
    return json({ models: results ?? [] });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
}

async function adminAddModel(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => ({})) as {
    model_id?: string;
    label?: string;
    provider?: string;
    supports_vision?: boolean;
    supports_streaming?: boolean;
  };
  const modelId = (body.model_id ?? "").trim();
  const label = (body.label ?? "").trim();
  const provider = (body.provider ?? "").trim();
  if (!modelId || !label || !provider) {
    return json({ error: "model_id, label, and provider are required" }, 400);
  }
  const validProviders = ["groq", "gemini", "agentrouter", "openrouter", "workers-ai"];
  if (!validProviders.includes(provider)) {
    return json({ error: `provider must be one of: ${validProviders.join(", ")}` }, 400);
  }
  const rowId = genId();
  try {
    await env.DB.prepare(
      "INSERT INTO admin_models (row_id, model_id, label, provider, supports_vision, supports_streaming) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(rowId, modelId, label, provider, body.supports_vision ? 1 : 0, body.supports_streaming !== false ? 1 : 0).run();
    return json({ row_id: rowId, model_id: modelId, label, provider }, 201);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("UNIQUE")) {
      return json({ error: `Model ID "${modelId}" already exists. Delete it first or use a different ID.` }, 409);
    }
    return json({ error: msg }, 500);
  }
}

async function adminDeleteModel(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => ({})) as { model_id?: string };
  const modelId = (body.model_id ?? "").trim();
  if (!modelId) return json({ error: "model_id is required" }, 400);
  try {
    const result = await env.DB.prepare("DELETE FROM admin_models WHERE model_id = ?").bind(modelId).run();
    if (result.meta.changes === 0) {
      return json({ error: `Model "${modelId}" not found` }, 404);
    }
    return json({ ok: true });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
}

async function adminUpdateModel(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => ({})) as {
    model_id?: string;
    label?: string;
    provider?: string;
    supports_vision?: boolean;
    supports_streaming?: boolean;
  };
  const modelId = (body.model_id ?? "").trim();
  if (!modelId) return json({ error: "model_id is required" }, 400);
  try {
    const existing = await env.DB.prepare("SELECT row_id FROM admin_models WHERE model_id = ?").bind(modelId).first();
    if (!existing) return json({ error: `Model "${modelId}" not found` }, 404);
    const updates: string[] = [];
    const values: (string | number)[] = [];
    if (body.label !== undefined) { updates.push("label = ?"); values.push(body.label); }
    if (body.provider !== undefined) {
      const validProviders = ["groq", "gemini", "agentrouter", "openrouter", "workers-ai"];
      if (!validProviders.includes(body.provider)) {
        return json({ error: `provider must be one of: ${validProviders.join(", ")}` }, 400);
      }
      updates.push("provider = ?");
      values.push(body.provider);
    }
    if (body.supports_vision !== undefined) { updates.push("supports_vision = ?"); values.push(body.supports_vision ? 1 : 0); }
    if (body.supports_streaming !== undefined) { updates.push("supports_streaming = ?"); values.push(body.supports_streaming ? 1 : 0); }
    if (updates.length === 0) return json({ ok: true });
    values.push(modelId);
    await env.DB.prepare(`UPDATE admin_models SET ${updates.join(", ")} WHERE model_id = ?`).bind(...values).run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
}

// ─── Admin: User Management ───────────────────────────

async function adminListAllUsers(env: Env): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT uid, email, display_name, photo_url, is_disabled, last_sign_in, created_at FROM user_profiles ORDER BY last_sign_in DESC NULLS LAST"
    ).all();
    return json({ users: results ?? [] });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
}

async function adminGetUserConversations(uid: string, env: Env): Promise<Response> {
  try {
    const user = await env.DB.prepare(
      "SELECT uid, email, display_name, photo_url, is_disabled, last_sign_in, created_at FROM user_profiles WHERE uid = ?"
    ).bind(uid).first();
    if (!user) return json({ error: "User not found" }, 404);

    const { results } = await env.DB.prepare(
      "SELECT id, title, model, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50"
    ).bind(uid).all();

    const conversationStats = await Promise.all(
      (results ?? []).map(async (conv: any) => {
        const row = await env.DB.prepare(
          "SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?"
        ).bind(conv.id).first<{ count: number }>();
        const msgCount = (row as any)?.count || 0;
        return { ...conv, message_count: msgCount };
      })
    );

    return json({ user, conversations: conversationStats });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
}

/* ----------------------------- Image Generation ----------------------------- */

/**
 * POST /api/generate-image
 * Generates an image using the selected model.
 *
 * Request body:
 *   - prompt: string (required) - text description or editing instruction
 *   - model?: string - model ID to use (auto-selected if omitted)
 *   - conversationId: string (required) - conversation to persist messages in
 *   - imageR2Key?: string - R2 key of a source image for img2img editing
 *   - imageMimeType?: string - MIME type of the source image
 *
 * Returns:
 *   - images: ImageGenResult[]
 *   - model: string (the model used)
 *   - modelSelection?: { modelId, label, reason } — auto-selection info
 *   - userMessageId, assistantMessageId: string
 */
async function handleGenerateImage(req: Request, user: FirebaseUser, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await req.json().catch(() => ({})) as {
    prompt?: string;
    model?: string;
    conversationId?: string;
    imageR2Key?: string;
    imageMimeType?: string;
  };

  const prompt = (body.prompt ?? "").trim();
  if (!prompt) return json({ error: "prompt is required" }, 400);

  const conversationId = body.conversationId;
  if (!conversationId) return json({ error: "conversationId is required" }, 400);

  const mergedModels = await getMergedModels(env);
  const imageGenModels = mergedModels.filter((m) => m.supportsImageGen);
  if (imageGenModels.length === 0) return json({ error: "No image generation models available" }, 400);

  const isEditing = !!body.imageR2Key;

  // Auto-select or use explicit model
  let modelId: string;
  let autoImageSelection: ModelSelection | undefined;
  if (body.model && imageGenModels.some((m) => m.id === body.model)) {
    modelId = body.model;
  } else if (body.model) {
    return json({ error: `Image generation model "${body.model}" not found` }, 400);
  } else {
    try {
      autoImageSelection = selectAutoImageModel(mergedModels, isEditing);
      modelId = autoImageSelection.modelId;
    } catch {
      return json({ error: "No image generation models available" }, 400);
    }
  }

  let inputReferences: { type: string; image_url: { url: string } }[] | undefined;
  if (body.imageR2Key) {
    const obj = await env.BUCKET.get(body.imageR2Key);
    if (obj) {
      const buf = await obj.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);
      const mimeType = body.imageMimeType || "image/png";
      inputReferences = [{ type: "image_url", image_url: { url: `data:${mimeType};base64,${b64}` } }];
    }
    if (!inputReferences) return json({ error: "Source image not found in storage." }, 404);
  }

  // Ensure conversation exists — scoped to the authenticated user
  let conv = await env.DB.prepare(
    "SELECT id, title, model FROM conversations WHERE id = ? AND user_id = ?"
  ).bind(conversationId, user.uid).first<Conversation>();
  if (!conv) {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT INTO conversations (id, user_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(conversationId, user.uid, prompt.slice(0, 40), modelId, now, now).run();
    conv = { id: conversationId, title: prompt.slice(0, 40), model: modelId, created_at: now, updated_at: now };
  }

  // Image generation with fallback loop
  let images: Awaited<ReturnType<typeof generateImage>> = [];
  let finalModelId = modelId;
  let finalSelection = autoImageSelection;
  const startTime = Date.now();

  try {
    let lastFailedModelId = "";
    let succeeded = false;

    while (!succeeded) {
      try {
        images = await generateImage(finalModelId, prompt, env, inputReferences);
        healthTracker.recordSuccess(
          (finalSelection?.provider || parseModelId(finalModelId).provider) + ":image",
          Date.now() - startTime
        );
        succeeded = true;
      } catch (err) {
        const failProvider = finalSelection?.provider || parseModelId(finalModelId).provider;
        healthTracker.recordFailure(failProvider + ":image");
        lastFailedModelId = finalModelId;

        if (autoImageSelection) {
          const fallback = selectFallbackImageModel(finalModelId, mergedModels, isEditing);
          if (fallback) {
            finalModelId = fallback.modelId;
            finalSelection = fallback;
            continue;
          }
        }
        // No more fallbacks or manual mode — re-throw original error
        throw err;
      }
    }

    // Persist messages
    const now = Math.floor(Date.now() / 1000);
    const userMsgId = genId();
    await env.DB.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, attachments, created_at) VALUES (?, ?, 'user', ?, '[]', ?)"
    ).bind(userMsgId, conversationId, prompt, now).run();

    const assistantMsgId = genId();
    const modelLabel = mergedModels.find((m) => m.id === finalModelId)?.label || finalModelId;

    // Upload each generated image to R2 (instead of embedding base64 in D1, which hits the 2MB row limit)
    const imageAttachments: AttachmentMeta[] = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const key = `generated/${conversationId}/${assistantMsgId}/${i}`;
      const binaryStr = atob(img.b64_json);
      const buf = new Uint8Array(binaryStr.length);
      for (let j = 0; j < binaryStr.length; j++) {
        buf[j] = binaryStr.charCodeAt(j);
      }
      await env.BUCKET.put(key, buf, {
        httpMetadata: { contentType: img.media_type },
        customMetadata: {
          source: "ai-generated",
          prompt: prompt.slice(0, 200),
          model: finalModelId,
        },
      });
      imageAttachments.push({
        id: genId(),
        name: `${isEditing ? "edited" : "generated"}-image-${i + 1}.png`,
        type: img.media_type,
        size: buf.byteLength,
        r2Key: key,
        kind: "image",
      });
    }

    // Build markdown content with /api/files/ URLs (small footprint in D1)
    const imageMarkdown = imageAttachments
      .map((att, i) => `![${isEditing ? "Edited" : "Generated"} Image ${i + 1}](/api/files/${encodeURIComponent(att.r2Key)})`)
      .join("\n\n");
    const assistantContent = `🎨 **${isEditing ? "Edited" : "Generated"} with ${modelLabel}**\n\n${imageMarkdown}\n\n*Prompt: ${prompt}*`;

    // Persist assistant message with image attachments (so deleteConversation cleans them up)
    await env.DB.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, attachments, model, created_at) VALUES (?, ?, 'assistant', ?, ?, ?, ?)"
    ).bind(assistantMsgId, conversationId, assistantContent, JSON.stringify(imageAttachments), finalModelId, now).run();
    await env.DB.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .bind(now, conversationId).run();

    const responseBody: Record<string, unknown> = {
      images,
      content: assistantContent,
      model: finalModelId,
      userMessageId: userMsgId,
      assistantMessageId: assistantMsgId,
    };

    // Increment guest usage for image generation (read from header, body already consumed)
    const guestClientId = req.headers.get("X-Guest-Client-Id");
    if (guestClientId) {
      ctx.waitUntil(incrementGuestUsage(guestClientId, "image_gen", env));
    }

    // Return model selection info for the frontend to display
    if (finalSelection) {
      responseBody.modelSelection = {
        modelId: finalSelection.modelId,
        label: modelLabel,
        reason: finalSelection.reason,
      };
    }

    return json(responseBody);
  } catch (err) {
    console.error("Image generation failed:", err);
    return json({ error: (err as Error).message }, 500);
  }
}

/* ----------------------------- OpenRouter Free Model Tester (temporary) ----------------------------- */

const OPENROUTER_FREE_MODELS = [
  // Chat / coding
  { id: "deepseek/deepseek-r1:free", label: "DeepSeek R1", type: "chat" },
  { id: "deepseek/deepseek-chat-v3-0324:free", label: "DeepSeek Chat v3", type: "chat" },
  { id: "meta-llama/llama-4-maverick:free", label: "Llama 4 Maverick", type: "chat" },
  { id: "meta-llama/llama-4-scout:free", label: "Llama 4 Scout", type: "chat" },
  { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B", type: "chat" },
  { id: "meta-llama/llama-3.1-8b-instruct:free", label: "Llama 3.1 8B", type: "chat" },
  { id: "qwen/qwen3-235b-a22b:free", label: "Qwen3 235B", type: "chat" },
  { id: "qwen/qwen3-30b-a3b:free", label: "Qwen3 30B", type: "chat" },
  { id: "zhipu-ai/glm-4-32b:free", label: "GLM-4 32B", type: "chat" },
  { id: "google/gemma-3-27b-it:free", label: "Gemma 3 27B", type: "chat" },
  { id: "mistralai/mistral-small-3.1-24b-instruct:free", label: "Mistral Small 3.1", type: "chat" },
  { id: "nousresearch/hermes-3-llama-3.1-70b:free", label: "Hermes 3 70B", type: "chat" },
  // Multimodal
  { id: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B", type: "chat" },
  { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B", type: "chat" },
];

async function testOpenRouterFreeModels(env: Env): Promise<Response> {
  const results: { model: string; label: string; status: string; latency: string; response?: string; error?: string }[] = [];

  for (const model of OPENROUTER_FREE_MODELS) {
    const start = Date.now();
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + env.OPENROUTER_API_KEY,
        },
        body: JSON.stringify({
          model: model.id,
          messages: [{ role: "user", content: "Reply with exactly one word: hello" }],
          max_tokens: 20,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const ms = Date.now() - start;
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        results.push({
          model: model.id,
          label: model.label,
          status: "error",
          latency: ms + "ms",
          error: `HTTP ${res.status}: ${err.slice(0, 150)}`,
        });
      } else {
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const content = data?.choices?.[0]?.message?.content || "(empty)";
        results.push({
          model: model.id,
          label: model.label,
          status: "ok",
          latency: ms + "ms",
          response: content.slice(0, 80),
        });
      }
    } catch (err) {
      const ms = Date.now() - start;
      results.push({
        model: model.id,
        label: model.label,
        status: "error",
        latency: ms + "ms",
        error: (err as Error).message.slice(0, 150),
      });
    }
  }

  return json({ results, timestamp: new Date().toISOString() });
}

/* ----------------------------- Prompt Enhancer ----------------------------- */

/**
 * POST /api/enhance
 * Enhances a user's prompt using the selected AI model.
 * Body: { text: string, model?: string }
 * Returns: { enhanced: string }
 */
async function enhancePrompt(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => ({})) as {
    text?: string;
    model?: string;
  };

  const text = (body.text ?? "").trim();
  if (!text) {
    return json({ error: "text is required" }, 400);
  }

  const mergedModels = await getMergedModels(env);
  const modelId = body.model && mergedModels.some((m) => m.id === body.model) ? body.model : mergedModels[0]?.id || MODELS[0].id;

  const systemPrompt =
    "You are a query enhancement assistant. Your task is to rephrase and improve the user's query " +
    "to make it clearer, more specific, and better structured. Fix any spelling or grammar issues. " +
    "Return ONLY the enhanced query text, nothing else. Do not add explanations, commentary, " +
    "or any prefixes like 'Enhanced query:'. Just output the improved version.";

  try {
    const providerMessages: ProviderMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ];

    let enhanced = "";
    enhanced = await streamChat(modelId, providerMessages, env, {
      onChunk: (chunk) => {
        enhanced += chunk;
      },
    });

    // Fallback to original if AI returns empty
    if (!enhanced.trim()) {
      enhanced = text;
    }

    return json({ enhanced: enhanced.trim() });
  } catch (err) {
    console.error("Enhance failed:", err);
    // Fallback: return original text
    return json({ enhanced: text, warning: (err as Error).message });
  }
}