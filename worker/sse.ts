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
 */

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
    delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }
    message?: { content?: unknown }
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
}

function newSink(): Sink {
  return { parts: [], finishReason: null, usage: null, error: null }
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
      sawContent = true
      sink.parts.push(text)
      await out.write(contentFrame(text))
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
      sink.parts.push(text)
      await out.write(contentFrame(text))
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
