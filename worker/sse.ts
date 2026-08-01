/**
 * Bridges AgentRouter's upstream stream to the frontend's SSE contract.
 *
 * We re-emit rather than pass through, which buys three things:
 *  - a guaranteed shape (`data: {"choices":[{"delta":{"content":"…"}}]}` then
 *    `data: [DONE]`), whatever framing quirks the upstream provider has;
 *  - reasoning tokens dropped, since `gpt-5.6-sol` is a reasoning model and the
 *    UI has nowhere to put them;
 *  - a way to report a mid-stream failure, as a `data: {"error":{…}}` frame,
 *    after the response headers have already been committed.
 *
 * ## AgentRouter does not really stream
 *
 * It waits for the full completion upstream and then synthesises a one-frame
 * SSE response — the chunk comes back as `"id":"chatcmpl_temp"` carrying the
 * entire answer, so even a long reply arrives as a single delta. This Worker
 * relays that faithfully and as fast as it can; re-chunking it into a
 * progressive typing effect is the client's job (see `paced()` in
 * src/lib/api.ts). Doing it here was tried and removed: Workers pin `Date.now()`
 * between I/O, so a paced loop cannot measure its own drift and reliably
 * overshot its budget by 2–4×, while also billing that sleep as wall-clock time.
 *
 * ## The persistence tap
 *
 * `toClientStream` takes an optional `onComplete`, called once with the full
 * assistant text and whatever usage numbers upstream reported. That is how the
 * assistant turn reaches D1 without the write sitting between the user and their
 * tokens: the frames go out, and the tap fires afterwards inside
 * `ctx.waitUntil`. It is a passive observer — it cannot change a frame, and a tap
 * that throws is swallowed, because a failed database write must not truncate a
 * reply the user is already reading.
 *
 * ## The tool peek
 *
 * `peekToolCalls` is the other half of this file, and it runs *before*
 * `toClientStream` rather than inside it. It reads just enough of an upstream
 * response to tell "the model wants to run a tool" from "the model is
 * answering", and on the second it hands back a replay so nothing is lost. It
 * lives here because it is stream surgery, and it is separate from the pumps for
 * the same reason the failover loop lives above `createChatCompletion`: nothing
 * that can restart a turn may sit downstream of the first byte to the client.
 *
 * ## The figure gate
 *
 * Every byte of assistant text passes through a `FigureGate` on its way to both
 * the client *and* `sink.parts`, so the copy persisted to D1 is the same
 * sanitised text the reader saw. It holds back ```` ```svg ```` blocks until
 * they are complete and cleaned; see `lib/figureGate.ts` for why that does not
 * conflict with the no-restart invariant above.
 *
 * There is deliberately no switch for it. `SVG_DIAGRAMS` decides whether the
 * *prompt* invites figures, but the gate runs regardless, because "no
 * unsanitised svg fence ever reaches a browser" is worth keeping as an
 * invariant with no off position — a user can always ask the model to echo SVG
 * back at them, feature flag or not.
 */

import type { ToolCall } from './agentrouter.ts'
import { FigureGate } from './lib/figureGate.ts'

const encoder = new TextEncoder()

export function contentFrame(text: string): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
}

export function errorFrame(message: string, type = 'stream_error'): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ error: { message, type } })}\n\n`)
}

export function doneFrame(): Uint8Array {
  return encoder.encode('data: [DONE]\n\n')
}

/** A comment line, flushed first so intermediaries open the stream promptly. */
export function commentFrame(text: string): Uint8Array {
  return encoder.encode(`: ${text}\n\n`)
}

interface UpstreamChunk {
  choices?: {
    delta?: {
      content?: unknown
      reasoning_content?: unknown
      reasoning?: unknown
      tool_calls?: unknown
    }
    message?: { content?: unknown; tool_calls?: unknown }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    total_tokens?: unknown
  }
  error?: { message?: unknown; type?: unknown }
  message?: unknown
}

export interface StreamUsage {
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
}

/** What the stream turned out to be, once it is over. */
export interface StreamResult {
  /** Everything sent to the client, concatenated. Empty on an immediate failure. */
  text: string
  /**
   * `'stop'` for a clean finish, `'aborted'` when the client hung up, `'error'`
   * when a frame carried a failure, or whatever upstream reported.
   */
  finishReason: string
  /** Present only when upstream sent a usage block; otherwise the caller estimates. */
  usage: StreamUsage | null
  /** The error message shown to the user, if the stream ended in one. */
  error: string | null
}

export type StreamTap = (result: StreamResult) => void

/** Mutable accumulator shared by the pumps and `toClientStream`. */
interface Sink {
  parts: string[]
  finishReason: string | null
  usage: StreamUsage | null
  error: string | null
  gate: FigureGate
}

function newSink(): Sink {
  return { parts: [], finishReason: null, usage: null, error: null, gate: new FigureGate() }
}

/**
 * The one way assistant text leaves this file.
 *
 * Both pumps go through here rather than writing `contentFrame` directly, so
 * there is a single place where the figure gate can hold bytes back — and so
 * `sink.parts`, which becomes the stored transcript, can never drift from what
 * was actually sent.
 */
async function emit(
  text: string,
  out: WritableStreamDefaultWriter<Uint8Array>,
  sink: Sink,
): Promise<void> {
  for (const piece of await sink.gate.push(text)) {
    sink.parts.push(piece)
    await out.write(contentFrame(piece))
  }
}

/**
 * Releases whatever the gate is still holding, at end of stream.
 *
 * Called before the terminating frame on every path, including the failure
 * ones: a reply that died mid-figure should show a truncated figure and say so,
 * not lose the figure and the prose that preceded it.
 */
async function drainGate(
  out: WritableStreamDefaultWriter<Uint8Array>,
  sink: Sink,
): Promise<void> {
  try {
    for (const piece of await sink.gate.flush()) {
      sink.parts.push(piece)
      await out.write(contentFrame(piece))
    }
  } catch (err) {
    // The client has usually just hung up. Nothing left to tell them.
    console.warn('[chatddb] figure gate flush failed: %s', describe(err))
  }
}

/** Pulls the assistant text out of one upstream SSE payload, if it has any. */
function extractContent(chunk: UpstreamChunk): string | null {
  const choice = chunk.choices?.[0]
  if (!choice) return null
  const delta = choice.delta?.content
  if (typeof delta === 'string' && delta.length > 0) return delta
  // Some relays send a whole message instead of a delta on the final chunk.
  const whole = choice.message?.content
  if (typeof whole === 'string' && whole.length > 0) return whole
  return null
}

function extractError(chunk: UpstreamChunk): string | null {
  if (chunk.error) {
    const message = chunk.error.message
    return typeof message === 'string' ? message : JSON.stringify(chunk.error)
  }
  return null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Reads a usage block, when upstream sends one.
 *
 * Requested via `stream_options.include_usage`; AgentRouter does not always
 * honour it, which is why `token_source` in `chat_messages` records whether a
 * count came from upstream or from our own character estimate.
 */
function extractUsage(chunk: UpstreamChunk): StreamUsage | null {
  const usage = chunk.usage
  if (!usage) return null
  const promptTokens = num(usage.prompt_tokens)
  const completionTokens = num(usage.completion_tokens)
  const totalTokens = num(usage.total_tokens)
  if (promptTokens === null && completionTokens === null && totalTokens === null) return null
  return { promptTokens, completionTokens, totalTokens }
}

/**
 * Reads an upstream SSE body and writes normalised frames to `out`.
 * Never throws: failures are written as error frames so the client always
 * sees a terminated stream.
 */
async function pumpEventStream(
  body: ReadableStream<Uint8Array>,
  out: WritableStreamDefaultWriter<Uint8Array>,
  sink: Sink,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sawContent = false

  const handleLine = async (line: string): Promise<boolean> => {
    // `:` comments are keep-alives; anything that is not a data field is noise.
    if (!line.startsWith('data:')) return false
    const payload = line.slice(5).trim()
    if (!payload) return false
    if (payload === '[DONE]') return true

    let chunk: UpstreamChunk
    try {
      chunk = JSON.parse(payload) as UpstreamChunk
    } catch {
      return false
    }

    const err = extractError(chunk)
    if (err) {
      sink.error = err
      sink.finishReason = 'error'
      // Before the error frame, not after: a figure interrupted by an upstream
      // failure should appear above the failure, in the order it happened.
      await drainGate(out, sink)
      await out.write(errorFrame(err, 'upstream_error'))
      return true
    }

    // Usage often rides on a final choice-less chunk, so read it before bailing
    // out on "no content here".
    const usage = extractUsage(chunk)
    if (usage) sink.usage = usage
    const reason = chunk.choices?.[0]?.finish_reason
    if (typeof reason === 'string' && reason.length > 0) sink.finishReason = reason

    const text = extractContent(chunk)
    if (text !== null) {
      // Tracks what *upstream* sent, not what the gate let through — a chunk
      // that is entirely the start of a figure emits nothing yet, and must not
      // be mistaken for an empty completion.
      sawContent = true
      await emit(text, out, sink)
    }
    return false
  }

  try {
    let finished = false
    while (!finished) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Split on line boundaries; SSE data fields are single lines here, and a
      // trailing partial line stays in the buffer until more bytes arrive.
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        if (await handleLine(raw.trim())) {
          finished = true
          break
        }
      }
    }
    if (!finished) {
      buffer += decoder.decode()
      for (const raw of buffer.split('\n')) {
        if (await handleLine(raw.trim())) break
      }
    }
    await drainGate(out, sink)
    if (!sawContent && sink.error === null) {
      const message = 'The model returned an empty response. Try again or rephrase the prompt.'
      sink.error = message
      sink.finishReason = 'error'
      await out.write(errorFrame(message, 'empty_completion'))
    }
  } catch (err) {
    if (isAbort(err)) {
      sink.finishReason = 'aborted'
    } else {
      const message = `Stream interrupted: ${err instanceof Error ? err.message : String(err)}`
      sink.error = message
      sink.finishReason = 'error'
      // The stream died mid-figure. Salvage the partial one — `flush()` closes,
      // sanitises and labels it — then report the failure underneath.
      await drainGate(out, sink)
      await out.write(errorFrame(message)).catch(() => {})
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

/**
 * Handles an upstream response that came back as one JSON body rather than a
 * stream — happens when a relay ignores `stream: true`.
 */
async function pumpJsonBody(
  res: Response,
  out: WritableStreamDefaultWriter<Uint8Array>,
  sink: Sink,
): Promise<void> {
  try {
    const chunk = (await res.json()) as UpstreamChunk
    const err = extractError(chunk)
    if (err) {
      sink.error = err
      sink.finishReason = 'error'
      await out.write(errorFrame(err, 'upstream_error'))
      return
    }
    const usage = extractUsage(chunk)
    if (usage) sink.usage = usage
    const reason = chunk.choices?.[0]?.finish_reason
    if (typeof reason === 'string' && reason.length > 0) sink.finishReason = reason

    const text = extractContent(chunk)
    if (text) {
      await emit(text, out, sink)
      await drainGate(out, sink)
    } else {
      const message = 'The model returned an empty response.'
      sink.error = message
      sink.finishReason = 'error'
      await out.write(errorFrame(message, 'empty_completion'))
    }
  } catch (err) {
    if (isAbort(err)) {
      sink.finishReason = 'aborted'
    } else {
      const message = `Could not read the model response: ${describe(err)}`
      sink.error = message
      sink.finishReason = 'error'
      await drainGate(out, sink)
      await out.write(errorFrame(message)).catch(() => {})
    }
  }
}

/**
 * Converts an upstream AgentRouter response into a client-facing SSE stream.
 * Returns immediately; the body fills in as upstream bytes arrive.
 *
 * `onComplete` fires exactly once, after the last frame is written, with the
 * assembled text. It is called synchronously, so anything asynchronous it starts
 * must be handed to `ctx.waitUntil` by the tap itself — which is exactly what
 * `routes/chat.ts` does with its D1 writes.
 */
export function toClientStream(res: Response, onComplete?: StreamTap): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const isEventStream = (res.headers.get('content-type') ?? '').includes('text/event-stream')
  const sink = newSink()

  void (async () => {
    try {
      await writer.write(commentFrame('chatddb stream open'))
      if (isEventStream && res.body) {
        await pumpEventStream(res.body, writer, sink)
      } else {
        await pumpJsonBody(res, writer, sink)
      }
      await writer.write(doneFrame())
    } catch (err) {
      if (isAbort(err)) {
        sink.finishReason = 'aborted'
      } else {
        const message = describe(err)
        sink.error = message
        sink.finishReason = 'error'
        // Harmless if a pump already drained: a flushed gate holds nothing and
        // returns no pieces the second time.
        await drainGate(writer, sink)
        await writer.write(errorFrame(message)).catch(() => {})
        await writer.write(doneFrame()).catch(() => {})
      }
    } finally {
      await writer.close().catch(() => {})
      if (onComplete) {
        try {
          onComplete({
            text: sink.parts.join(''),
            finishReason: sink.finishReason ?? 'stop',
            usage: sink.usage,
            error: sink.error,
          })
        } catch (err) {
          // A tap must never be able to break a stream the client already read.
          console.error('stream tap failed', err)
        }
      }
    }
  })()

  return readable
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

/**
 * The model asked to run a tool. Nothing was shown to the client.
 *
 * There is no `res` to hand on: a tool-call response carries no prose, so the
 * caller executes the tool and asks again rather than streaming this.
 */
export interface PeekedToolCalls {
  kind: 'tool'
  calls: ToolCall[]
}

/**
 * The model answered normally.
 *
 * `res` is a *replay* of the original — the bytes already read, followed by the
 * rest of the live stream — so the caller can hand it to `toClientStream` and
 * nothing is lost or duplicated.
 */
export interface PeekedText {
  kind: 'text'
  res: Response
}

export type PeekResult = PeekedToolCalls | PeekedText

/**
 * Looks at an upstream response just far enough to tell a tool call from prose.
 *
 * ## Why this has to exist
 *
 * `routes/chat.ts` must know whether the model wants a tool *before*
 * `toClientStream` writes its first frame, because once a byte reaches the
 * client the turn is committed — that is the invariant `failover.ts` is built
 * around. But the only way to know is to read the body, and reading the body is
 * exactly what would consume it. So this reads, decides, and then hands back
 * either the assembled calls or a response that replays what it read.
 *
 * The alternative — asking with `stream: false` on the tool-offering leg — was
 * rejected: it would turn every reply into a single blob for whichever gateway
 * genuinely streams, in exchange for deleting the twenty lines of replay below.
 *
 * ## The shape this parses, and how it was established
 *
 * `npm run probe:tools` phase 5, against `gpt-5.6-sol` through AgentRouter, 5/5
 * runs. Two findings drive the code:
 *
 *  - The call arrives as **`delta.tool_calls`**, OpenAI's fragmented form, and
 *    the first frame carries `id`, `type`, `index` and `function.name` with an
 *    **empty** `function.arguments`. So the decision is available on frame one,
 *    which is what makes peeking cheap.
 *  - `function.arguments` is then split across roughly **150 further frames**,
 *    one token each. They have to be concatenated before `JSON.parse` — a parse
 *    of any single frame fails. This is the one place AgentRouter really does
 *    stream, incidentally: ordinary text comes back as a single blob.
 *
 * `message.tool_calls` is accepted too, for a relay that sends a whole message
 * on one frame, the same way `extractContent` already tolerates both.
 *
 * ## First signal wins
 *
 * Whichever appears first — content or a tool call — decides the turn. A model
 * that wrote a sentence *and then* called a tool gets its sentence streamed and
 * the call ignored, because the alternative is discarding text the user was
 * about to read. The probe's restraint phase (5/5 quiet on a non-visual
 * question) is the evidence that this is a corner and not the common case.
 */
export async function peekToolCalls(res: Response): Promise<PeekResult> {
  const isEventStream = (res.headers.get('content-type') ?? '').includes('text/event-stream')

  // A relay that ignored `stream: true`. One JSON body, so there is nothing to
  // peek at — read it whole and rebuild it for the caller.
  if (!isEventStream || !res.body) {
    const text = await res.text()
    const partials = new Map<number, PartialToolCall>()
    try {
      const chunk = JSON.parse(text) as UpstreamChunk
      const raw = chunk.choices?.[0]?.message?.tool_calls ?? chunk.choices?.[0]?.delta?.tool_calls
      if (Array.isArray(raw)) for (const call of raw) mergeToolCall(partials, call)
    } catch {
      /* not JSON; fall through to replaying it verbatim */
    }
    const calls = assembleToolCalls(partials)
    if (calls.length > 0) return { kind: 'tool', calls }
    return { kind: 'text', res: rebuild(res, text) }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  /**
   * Every raw chunk read, kept so the text path can replay byte-for-byte.
   *
   * Unbounded in principle, bounded in practice by `maxOutputTokens` — tens of
   * kilobytes. Kept even after a tool call is spotted, so that a call which
   * turns out to be unusable can still fall back to replaying the original.
   */
  const head: Uint8Array[] = []
  const partials = new Map<number, PartialToolCall>()
  let pending = ''
  let sawTool = false

  try {
    let done = false
    while (!done) {
      const next = await reader.read()
      if (next.done) break
      head.push(next.value)
      pending += decoder.decode(next.value, { stream: true })

      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const raw of lines) {
        const verdict = inspectLine(raw.trim(), partials)
        if (verdict === 'tool') sawTool = true
        // Prose, and no tool call before it: stop reading and let the client
        // have the stream. `reader` is handed on mid-flight, not restarted.
        else if (verdict === 'text' && !sawTool) {
          return { kind: 'text', res: replay(res, head, reader) }
        }
      }
    }
  } catch (err) {
    // The stream broke while we were looking at it. Replaying is still the right
    // move: `pumpEventStream` will hit the same failure and turn it into the
    // error frame the client already knows how to render.
    console.warn('[chatddb] tool peek failed, replaying stream: %s', err)
    return { kind: 'text', res: replay(res, head, reader) }
  }

  const calls = sawTool ? assembleToolCalls(partials) : []
  if (calls.length > 0) return { kind: 'tool', calls }
  // Either plain text that never produced a content frame, or a tool call too
  // mangled to use. Both are the pump's problem now, and it has answers for both.
  return { kind: 'text', res: replay(res, head, reader) }
}

/** One `delta.tool_calls` slot, keyed by the `index` the stream assigns it. */
interface PartialToolCall {
  id: string
  name: string
  args: string
}

/** What one SSE line tells us about where this turn is going. */
function inspectLine(line: string, partials: Map<number, PartialToolCall>): 'tool' | 'text' | null {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return null

  let chunk: UpstreamChunk
  try {
    chunk = JSON.parse(payload) as UpstreamChunk
  } catch {
    return null
  }
  const choice = chunk.choices?.[0]
  if (!choice) return null

  const raw = choice.delta?.tool_calls ?? choice.message?.tool_calls
  if (Array.isArray(raw) && raw.length > 0) {
    for (const call of raw) mergeToolCall(partials, call)
    return 'tool'
  }

  const content = choice.delta?.content ?? choice.message?.content
  if (typeof content === 'string' && content.length > 0) return 'text'
  return null
}

/** Folds one fragment into its slot. `arguments` concatenates; the rest wins once. */
function mergeToolCall(partials: Map<number, PartialToolCall>, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return
  const call = raw as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }
  // Absent on a relay that sends whole calls; a single call is index 0.
  const index = typeof call.index === 'number' ? call.index : 0
  const slot = partials.get(index) ?? { id: '', name: '', args: '' }

  if (typeof call.id === 'string' && call.id.length > 0) slot.id = call.id
  if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
    slot.name = call.function.name
  }
  if (typeof call.function?.arguments === 'string') slot.args += call.function.arguments

  partials.set(index, slot)
}

/** Slots to calls, in stream order. A slot with no name never became a call. */
function assembleToolCalls(partials: Map<number, PartialToolCall>): ToolCall[] {
  return [...partials.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, slot]) => slot.name.length > 0)
    .map(([index, slot]) => ({
      // Synthesised only if the gateway omitted one: the id has to survive into
      // the `tool_call_id` of the result message or the model cannot match them.
      id: slot.id || `call_${index}`,
      type: 'function' as const,
      function: { name: slot.name, arguments: slot.args },
    }))
}

/**
 * The chunks already read, then the rest of the live stream.
 *
 * Only `content-type` is carried over: the body has been through a
 * `ReadableStream` reader, so it is already decoded, and passing on a
 * `content-encoding` header would describe bytes that no longer exist.
 */
function replay(
  res: Response,
  head: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Response {
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent < head.length) {
        controller.enqueue(head[sent++])
        return
      }
      try {
        const { done, value } = await reader.read()
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (err) {
        controller.error(err)
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {})
    },
  })
  return rebuild(res, stream)
}

function rebuild(res: Response, body: BodyInit): Response {
  const contentType = res.headers.get('content-type')
  return new Response(body, {
    status: res.status,
    headers: contentType ? { 'Content-Type': contentType } : {},
  })
}

/** A stream that only carries one error, for failures found before streaming. */
export function errorStream(message: string, type: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(errorFrame(message, type))
      controller.enqueue(doneFrame())
      controller.close()
    },
  })
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message))
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
