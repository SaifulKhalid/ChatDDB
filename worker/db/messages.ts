/**
 * `chat_messages`: inserts, history rebuild, transcripts.
 *
 * ## Server-authoritative history
 *
 * Before Phase 2 the client posted the entire conversation on every turn and the
 * Worker trusted it. `historyFor()` replaces that: the server rebuilds context
 * from its own rows, so a client can no longer forge an assistant turn, inject
 * text attributed to the model, or splice in another user's message. This is the
 * single biggest security gain of the phase, and it is why the request body
 * changed shape.
 */

import { all, first, scalar, stmt, type Stmt } from './client.ts'
import { newId } from '../lib/hash.ts'

export type MessageRole = 'user' | 'assistant' | 'system'
export type TokenSource = 'upstream' | 'estimate'

export interface MessageRow {
  id: string
  session_id: string
  user_id: string
  role: MessageRole
  message_content: string
  model_provider: string | null
  model_used: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
  token_source: TokenSource | null
  attachment_count: number
  finish_reason: string | null
  error: string | null
  created_at: number
}

export interface PublicMessage {
  id: string
  role: MessageRole
  content: string
  createdAt: number
  model?: string | null
  attachmentCount?: number
  error?: string | null
  finishReason?: string | null
  tokens?: { prompt: number | null; completion: number | null; total: number | null; source: TokenSource | null }
}

/**
 * Public service names, exactly as migration 0007 seeds `ai_services.public_name`.
 *
 * A row already carrying one of these is passed through untouched, which is the
 * ordinary case: `persistAssistant` in `routes/chat.ts` stores
 * `service.public_name`, never the upstream id.
 */
const PUBLIC_SERVICE_NAMES: readonly string[] = [
  'ChatGPT',
  'Gemini',
  'Claude',
  'DeepSeek',
  'GLM',
  'Grok',
]

/**
 * Upstream model-id families mapped to the public service that fronts them,
 * matched as a **prefix** rather than anywhere in the string.
 *
 * Every prefix here is the leading segment of an id migration 0007 actually
 * seeds into `ai_routes.upstream_model_id` (`gpt-5.6-sol`, `gemini-3.7-flash`,
 * `claude-opus-5`, `deepseek-v4-flash`, `glm-5.3`), plus `grok-` for the sixth
 * seeded service. It exists for rows written before the catalogue did, and for
 * anything that stores an upstream id by mistake.
 */
const UPSTREAM_FAMILIES: readonly (readonly [prefix: string, service: string])[] = [
  ['gpt-', 'ChatGPT'],
  ['gemini-', 'Gemini'],
  ['claude-', 'Claude'],
  ['deepseek-', 'DeepSeek'],
  ['glm-', 'GLM'],
  ['grok-', 'Grok'],
]

/**
 * Image-generation model ids, which are namespaced by their provider: Workers AI
 * keeps its `@cf/...` id and Pollinations is prefixed `pollinations/` (see
 * `GeneratedImage.model` in `images.ts`). Both name the upstream vendor outright,
 * so neither may reach a client.
 */
const IMAGE_MODEL_PREFIXES: readonly string[] = ['@cf/', 'pollinations/']

/** What an image row shows instead of the vendor's model id. */
const IMAGE_LABEL = 'Image'

/**
 * Maps a stored `model_used` to the name a client is allowed to see.
 *
 * ## Why this is not substring matching
 *
 * The previous implementation asked `lower.includes(...)` against a list of
 * vendor fragments, one of which was `'sol'` -- three letters that appear in
 * `solar-10.7b`, `console-preview`, and any number of ids that have nothing to
 * do with ChatGPT. Classification depended on accidents of spelling, so adding a
 * model could silently relabel an unrelated one. Matching is now anchored: an
 * exact public name, or a family prefix at position zero.
 *
 * ## Why an unrecognised id returns null rather than itself
 *
 * The old fallback returned the raw value, and that was a live leak, not a latent
 * one. `routes/images.ts` stores `image.model` on the assistant row, so every
 * generated image already had `@cf/black-forest-labs/flux-1-schnell` (or
 * `pollinations/<model>`) sitting in `model_used`, and `MessageItem.tsx` renders
 * `message.model` verbatim in a badge. Reloading a conversation showed users the
 * vendor and model that drew their picture. Anything unrecognised is now
 * withheld: the badge simply does not render, which is the correct answer to
 * "which of our services answered this?" when we cannot say.
 *
 * This is the single choke point for the question, so it also sanitises rows
 * already in the database. The image write path is left alone deliberately --
 * `files.gen_model` is the documented home for image provenance and the admin
 * inspector reads it there, so rewriting `model_used` would discard operator
 * detail without making anything safer.
 */
export function toPublicModelKey(modelUsed: string | null | undefined): string | null | undefined {
  if (!modelUsed) return modelUsed

  const trimmed = modelUsed.trim()
  const lower = trimmed.toLowerCase()

  const known = PUBLIC_SERVICE_NAMES.find((name) => name.toLowerCase() === lower)
  if (known) return known

  for (const [prefix, service] of UPSTREAM_FAMILIES) {
    if (lower.startsWith(prefix)) return service
  }

  if (IMAGE_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix))) return IMAGE_LABEL

  return null
}

export function toPublicMessage(row: MessageRow): PublicMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.message_content,
    createdAt: row.created_at,
    model: toPublicModelKey(row.model_used),
    attachmentCount: row.attachment_count,
    error: row.error,
    finishReason: row.finish_reason,
  }
}

export interface InsertMessage {
  id?: string
  sessionId: string
  userId: string
  role: MessageRole
  content: string
  modelProvider?: string | null
  model?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  totalTokens?: number | null
  tokenSource?: TokenSource | null
  attachmentCount?: number
  finishReason?: string | null
  error?: string | null
  createdAt?: number
}

/** Builds the insert as a statement so it can share a batch with the counters. */
export function insertStmt(input: InsertMessage): { id: string; stmt: Stmt } {
  const id = input.id ?? newId()
  return {
    id,
    stmt: stmt(
      `INSERT INTO chat_messages
         (id, session_id, user_id, role, message_content, model_provider, model_used,
          prompt_tokens, completion_tokens, total_tokens, token_source,
          attachment_count, finish_reason, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.sessionId,
      input.userId,
      input.role,
      input.content,
      input.modelProvider ?? null,
      input.model ?? null,
      input.promptTokens ?? null,
      input.completionTokens ?? null,
      input.totalTokens ?? null,
      input.tokenSource ?? null,
      input.attachmentCount ?? 0,
      input.finishReason ?? null,
      input.error ?? null,
      input.createdAt ?? Date.now(),
    ),
  }
}

/**
 * Rebuilds conversation context from D1.
 *
 * Two caps, both necessary. `maxTurns` bounds the row read; `maxChars` bounds
 * what actually goes upstream, because thirty short turns and thirty
 * 200k-character turns are very different prompts. Rows come back newest-first,
 * are trimmed from the oldest end until they fit, then reversed into
 * chronological order.
 *
 * Failed and aborted assistant turns are excluded: replaying a half-finished or
 * errored answer as if the model had said it degrades the next reply.
 */
export async function historyFor(
  db: D1Database,
  sessionId: string,
  maxTurns: number,
  maxChars: number,
): Promise<{ role: MessageRole; content: string }[]> {
  const rows = await all<{ role: MessageRole; message_content: string }>(
    db,
    `SELECT role, message_content
       FROM chat_messages
      WHERE session_id = ?
        AND error IS NULL
        AND (finish_reason IS NULL OR finish_reason <> 'aborted')
        AND length(message_content) > 0
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?`,
    sessionId,
    maxTurns,
  )

  const kept: { role: MessageRole; content: string }[] = []
  let chars = 0
  for (const row of rows) {
    const length = row.message_content.length
    if (chars + length > maxChars && kept.length > 0) break
    kept.push({ role: row.role, content: row.message_content })
    chars += length
  }
  return kept.reverse()
}

export function listForSession(db: D1Database, sessionId: string): Promise<MessageRow[]> {
  return all<MessageRow>(
    db,
    `SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
    sessionId,
  )
}

export function get(db: D1Database, id: string): Promise<MessageRow | null> {
  return first<MessageRow>(db, `SELECT * FROM chat_messages WHERE id = ?`, id)
}

/** The newest message in a session, whatever its role. Regenerate needs this. */
export function lastForSession(db: D1Database, sessionId: string): Promise<MessageRow | null> {
  return first<MessageRow>(
    db,
    `SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    sessionId,
  )
}

/**
 * The newest *user* message in a session.
 *
 * Regenerating re-answers this turn, so its attachments have to be reloaded --
 * the images and documents have to go back upstream with it or the second answer
 * would be worse than the first for no visible reason.
 */
export function lastUserForSession(db: D1Database, sessionId: string): Promise<MessageRow | null> {
  return first<MessageRow>(
    db,
    `SELECT * FROM chat_messages
      WHERE session_id = ? AND role = 'user'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    sessionId,
  )
}

/** Statement form of an update to an already-inserted assistant message. */
export function finaliseStmt(
  id: string,
  patch: {
    content: string
    finishReason?: string | null
    error?: string | null
    promptTokens?: number | null
    completionTokens?: number | null
    totalTokens?: number | null
    tokenSource?: TokenSource | null
  },
): Stmt {
  return stmt(
    `UPDATE chat_messages
        SET message_content = ?, finish_reason = ?, error = ?,
            prompt_tokens = ?, completion_tokens = ?, total_tokens = ?, token_source = ?
      WHERE id = ?`,
    patch.content,
    patch.finishReason ?? null,
    patch.error ?? null,
    patch.promptTokens ?? null,
    patch.completionTokens ?? null,
    patch.totalTokens ?? null,
    patch.tokenSource ?? null,
    id,
  )
}

/**
 * Drops a message and everything after it in its session.
 *
 * This is what "edit an earlier message" and "regenerate" need: the old branch
 * is discarded, matching what the UI already did locally before Phase 2. Scoped
 * by `session_id` *and* `user_id` so it can only ever truncate the caller's own
 * conversation.
 */
export function truncateFromStmt(sessionId: string, userId: string, fromCreatedAt: number, inclusive: boolean): Stmt {
  return stmt(
    `DELETE FROM chat_messages
      WHERE session_id = ? AND user_id = ? AND created_at ${inclusive ? '>=' : '>'} ?`,
    sessionId,
    userId,
    fromCreatedAt,
  )
}

/** Recomputes `chat_sessions.message_count` after a truncation. */
export function recountStmt(sessionId: string): Stmt {
  return stmt(
    `UPDATE chat_sessions
        SET message_count = (SELECT COUNT(*) FROM chat_messages WHERE session_id = ?)
      WHERE id = ?`,
    sessionId,
    sessionId,
  )
}

export function countForSession(db: D1Database, sessionId: string): Promise<number> {
  return scalar(db, `SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?`, sessionId)
}

/**
 * A crude token estimate for when the upstream provider reports no usage block.
 *
 * Four characters per token is the usual English rule of thumb. Anything stored
 * from here is marked `token_source='estimate'` and the admin UI labels it, so
 * it is never mistaken for a billing figure.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}
