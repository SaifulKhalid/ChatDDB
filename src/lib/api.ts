/**
 * Chat streaming and conversation CRUD.
 *
 * `POST /api/chat` no longer takes a `messages` array — the Worker rebuilds
 * history from D1 and the client contributes only the current turn. The three
 * modes (send / edit / regenerate) are all this one call:
 *
 *   send        { content }
 *   edit        { content, replaceFromMessageId }
 *   regenerate  { regenerate: true }
 *
 * The ids the server assigns come back in headers (`X-ChatDDB-Session-Id`,
 * `X-ChatDDB-Message-Id`) rather than in a frame, so a brand-new conversation
 * gets its id before the first token instead of after the last one. That is what
 * `onMeta` delivers.
 *
 * The pre-Phase-2 mock-reply fallback is gone: with login required, an
 * unreachable backend can no longer be papered over with a fake answer, and a
 * fake answer that looked real was the more dangerous of the two behaviours.
 */

import { apiFetch, apiJson, toApiError } from './apiClient'
import type {
  CreateSessionResponse,
  ImageResponse,
  ImportResponse,
  ModelsResponse,
  PublicFile,
  SessionListResponse,
  SessionSummary,
  TranscriptResponse,
} from './apiTypes'

export interface ChatRequest {
  sessionId?: string
  content?: string
  attachments?: string[]
  model?: string
  replaceFromMessageId?: string
  regenerate?: boolean
}

export interface StreamMeta {
  sessionId: string | null
  messageId: string | null
  model: string | null
  generatedFileId: string | null
  generatedFile: PublicFile | null
  /**
   * Present only when a backup gateway answered because the primary failed.
   * The Worker sets the header pair on a crossover; its absence means the
   * primary answered and no notice is owed.
   */
  upstream: string | null
  upstreamModel: string | null
}

export async function* streamChat(
  request: ChatRequest,
  signal: AbortSignal,
  onMeta?: (meta: StreamMeta) => void,
): AsyncGenerator<string> {
  const res = await apiFetch('/api/chat', { method: 'POST', json: request, signal })

  if (!res.ok || !res.body) throw await toApiError(res)

  const genFileJson = res.headers.get('X-ChatDDB-Generated-File-JSON')
  let generatedFile: PublicFile | null = null
  if (genFileJson) {
    try {
      generatedFile = JSON.parse(decodeURIComponent(genFileJson))
    } catch {
      generatedFile = null
    }
  }

  onMeta?.({
    sessionId: res.headers.get('X-ChatDDB-Session-Id'),
    messageId: res.headers.get('X-ChatDDB-Message-Id'),
    model: res.headers.get('X-ChatDDB-Model'),
    generatedFileId: res.headers.get('X-ChatDDB-Generated-File'),
    generatedFile,
    upstream: res.headers.get('X-ChatDDB-Upstream'),
    upstreamModel: res.headers.get('X-ChatDDB-Upstream-Model'),
  })

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const sse = (res.headers.get('content-type') ?? '').includes('text/event-stream')
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const text = decoder.decode(value, { stream: true })
    if (!sse) {
      if (text) yield text
      continue
    }

    buffer += text
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') return
      let frame: {
        error?: { message?: unknown }
        choices?: { delta?: { content?: unknown } }[]
        content?: unknown
        delta?: unknown
      }
      try {
        const parsed: unknown = JSON.parse(data)
        // `JSON.parse('null')` returns null instead of throwing, so the catch
        // below does not cover it and `frame.error` would be a TypeError. Our
        // Worker never emits `data: null` — it writes its own frames — but this is
        // the bug that took Claude streams down inside `worker/sse.ts`, and the
        // reader is a cheaper place to be wrong than the relay.
        if (typeof parsed !== 'object' || parsed === null) continue
        frame = parsed
      } catch {
        // Keep-alives and comments are not JSON; a malformed frame is not fatal.
        continue
      }
      // A failure the Worker hit after the headers went out.
      if (frame.error) throw new Error(String(frame.error.message ?? 'The model request failed.'))
      const delta = frame.choices?.[0]?.delta?.content ?? frame.content ?? frame.delta
      if (typeof delta === 'string' && delta.length > 0) yield* paced(delta, signal)
    }
  }
}

/** Deltas at or below this length already look like real streaming. */
const PACE_MIN_CHARS = 24
/** Roughly how long one oversized delta is spread across. */
const PACE_BUDGET_MS = 700

/**
 * Renders a delta progressively instead of all at once.
 *
 * The upstream gateway buffers the full
 * completion upstream for some models and sends it as a single SSE frame, so without this the UI
 * would sit empty and then paste the whole answer in one repaint. Genuinely
 * incremental deltas are short, fall under PACE_MIN_CHARS, and pass straight
 * through — so if the upstream provider performs real incremental streaming this stops doing
 * anything.
 */
async function* paced(text: string, signal: AbortSignal): AsyncGenerator<string> {
  if (text.length <= PACE_MIN_CHARS) {
    yield text
    return
  }
  const words = text.match(/\S+\s*|\s+/g)
  if (!words || words.length < 2) {
    yield text
    return
  }

  const started = performance.now()
  for (const [i, word] of words.entries()) {
    if (signal.aborted) return
    yield word
    // Pace against a deadline so the total stays near PACE_BUDGET_MS however
    // coarse the host's timers are.
    const target = ((i + 1) / words.length) * PACE_BUDGET_MS
    const drift = target - (performance.now() - started)
    if (drift > 4) await new Promise((r) => setTimeout(r, Math.min(drift, 40)))
  }
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export function listSessions(limit = 100): Promise<SessionListResponse> {
  return apiJson<SessionListResponse>(`/api/sessions?limit=${limit}`)
}

export function getTranscript(id: string): Promise<TranscriptResponse> {
  return apiJson<TranscriptResponse>(`/api/sessions/${id}`)
}

export async function createSession(title?: string): Promise<SessionSummary> {
  const res = await apiJson<CreateSessionResponse>('/api/sessions', {
    method: 'POST',
    json: { title },
  })
  return res.session
}

export function renameSession(id: string, title: string): Promise<{ ok: true; title: string }> {
  return apiJson(`/api/sessions/${id}`, { method: 'PATCH', json: { title } })
}

export function deleteSession(id: string): Promise<{ ok: true }> {
  return apiJson(`/api/sessions/${id}`, { method: 'DELETE' })
}

export function importSessions(
  sessions: { title: string; createdAt: number; updatedAt: number; messages: { role: string; content: string; createdAt: number }[] }[],
): Promise<ImportResponse> {
  return apiJson<ImportResponse>('/api/sessions/import', { method: 'POST', json: { sessions } })
}

export function getModels(): Promise<ModelsResponse> {
  return apiJson<ModelsResponse>('/api/models')
}

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

/**
 * Generates one image from a prompt.
 *
 * Not a stream, unlike `streamChat`: the model produces a whole image in one
 * shot, so there is nothing to render progressively and a fake event stream
 * would only add a parser for no benefit. The trade is a longer wait with no
 * intermediate feedback — the caller shows a placeholder for the duration.
 */
export function generateImage(
  request: { sessionId?: string; prompt: string },
  signal?: AbortSignal,
): Promise<ImageResponse> {
  return apiJson<ImageResponse>('/api/images', { method: 'POST', json: request, signal })
}
