/**
 * PDF text extraction, client mode.
 *
 * ## Why this exists
 *
 * The chosen architecture is server-side extraction with unpdf (`pdf-worker.ts`).
 * It cannot run on Workers Free: the plan allows **10 ms of CPU per request**
 * and PDF.js parsing is pure CPU measured in hundreds of milliseconds per
 * document, so a single page overruns the budget by 10-100x and the request dies
 * with error 1102. Free has no Queues and gives cron 10 ms too, so there is no
 * background path either. `PDF_EXTRACT_MODE=client` is therefore the default,
 * and this module is what runs.
 *
 * ## The text is untrusted, and that is bounded
 *
 * In this mode the browser extracts with pdf.js and posts the text alongside the
 * file, so a user *could* send text that does not match their PDF. Stated
 * plainly, the blast radius: it pollutes that user's own conversation context
 * and their own log rows. It cannot reach another user's data, it is not an
 * injection vector into the Worker (the text is only ever a bound parameter and
 * a delimited prompt block), and the original PDF is kept as the authority --
 * re-extracting server-side after a plan upgrade corrects the record.
 *
 * Everything stored this way carries `extraction_source='client'`, which the
 * admin UI displays, so no reviewer mistakes it for a server-side reading.
 */

import { badRequest } from '../http.ts'
import type { ExtractionResult } from '../../db/files.ts'
import { textKey } from './detect.ts'

/** Preview kept in D1 so the admin file list needs no R2 read. */
export const PREVIEW_CHARS = 2_000

/**
 * Hard ceiling on accepted client text.
 *
 * Generous next to what any real document yields, but finite: without it a
 * client could post an arbitrarily large body and charge it to our R2 bill.
 */
export const MAX_CLIENT_TEXT_CHARS = 2_000_000

export interface ClientExtraction {
  text: string
  pages?: number
}

/**
 * Validates a client-supplied extraction from a multipart field.
 *
 * Returns `null` when the field is absent, which is not an error -- the file is
 * simply stored with `processing_status='pending'` and can be extracted later.
 */
export function parseClientExtraction(raw: string | null): ClientExtraction | null {
  if (raw === null) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw badRequest('The `extraction` field must be JSON.', 'invalid_extraction')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw badRequest('The `extraction` field must be a JSON object.', 'invalid_extraction')
  }

  const { text, pages } = parsed as { text?: unknown; pages?: unknown }
  if (typeof text !== 'string') {
    throw badRequest('`extraction.text` must be a string.', 'invalid_extraction')
  }
  if (text.length > MAX_CLIENT_TEXT_CHARS) {
    throw badRequest(
      `Extracted text is too long (${text.length} characters; the limit is ${MAX_CLIENT_TEXT_CHARS}).`,
      'extraction_too_large',
    )
  }

  return {
    text: normaliseText(text),
    pages: typeof pages === 'number' && Number.isFinite(pages) && pages > 0 ? Math.floor(pages) : undefined,
  }
}

/**
 * Collapses the whitespace debris pdf.js leaves behind.
 *
 * Text-layer extraction emits a lot of stray runs of spaces and hard line breaks
 * mid-sentence. Left alone these waste context tokens and make paragraph-aware
 * chunking useless, so they are normalised here rather than at every read.
 */
export function normaliseText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Stores extracted text in R2 and returns the row patch for `files`. */
export async function storeExtraction(
  bucket: R2Bucket,
  fileKey: string,
  extraction: ClientExtraction,
  source: 'client' | 'worker',
): Promise<ExtractionResult> {
  const key = textKey(fileKey)

  if (extraction.text.length === 0) {
    // A scanned PDF with no text layer. Not a failure -- there is genuinely
    // nothing to extract -- so it gets its own status and the UI can say why.
    return {
      textKey: null,
      preview: null,
      chars: 0,
      pages: extraction.pages ?? null,
      source,
      status: 'unsupported',
    }
  }

  await bucket.put(key, extraction.text, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    customMetadata: { extractionSource: source },
  })

  return {
    textKey: key,
    preview: extraction.text.slice(0, PREVIEW_CHARS),
    chars: extraction.text.length,
    pages: extraction.pages ?? null,
    source,
    status: 'done',
  }
}

/** Reads previously extracted text back for prompt assembly. */
export async function loadExtractedText(bucket: R2Bucket, key: string): Promise<string | null> {
  const object = await bucket.get(key)
  if (!object) return null
  return object.text()
}
