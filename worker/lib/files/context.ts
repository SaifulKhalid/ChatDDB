/**
 * Turning attachments into prompt content.
 *
 * Two jobs: assemble image parts as data URLs, and inject a *bounded* slice of a
 * PDF's extracted text. A whole document is never sent -- `PDF_CONTEXT_CHARS`
 * (24k by default) of the most relevant chunks is.
 *
 * ## Chunking, and the RAG upgrade it sets up
 *
 * Chunks are cut on paragraph boundaries with a small overlap, then scored
 * against the user's question by term overlap. That scoring is deliberately
 * simple -- it is lexical, not semantic -- but the *boundaries* are the point:
 * they are exactly what a future `file_chunks(file_id, idx, text, embedding)`
 * table would index, so adding embeddings later becomes "store vectors for the
 * chunks we already cut" rather than a redesign.
 */

import type { FileRow } from '../../db/files.ts'
import { loadExtractedText } from './pdf-client.ts'

/** Target chunk size in characters. Roughly 250-400 tokens of prose. */
const CHUNK_CHARS = 1_400
/** Overlap between neighbours, so a sentence split across a seam survives. */
const CHUNK_OVERLAP = 160

export interface Chunk {
  idx: number
  text: string
}

/**
 * Splits text into overlapping, paragraph-aware chunks.
 *
 * Paragraphs are kept whole where they fit; one longer than a chunk is split on
 * its own rather than being dropped or truncated.
 */
export function chunkText(text: string, chunkChars = CHUNK_CHARS, overlap = CHUNK_OVERLAP): Chunk[] {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  const chunks: Chunk[] = []
  let buffer = ''

  const flush = () => {
    const trimmed = buffer.trim()
    if (trimmed.length > 0) chunks.push({ idx: chunks.length, text: trimmed })
    // Carry the tail forward so the next chunk has the end of this one for
    // context; that is what stops a definition and its use being separated.
    buffer = overlap > 0 && trimmed.length > overlap ? `${trimmed.slice(-overlap)}\n\n` : ''
  }

  for (const paragraph of paragraphs) {
    if (paragraph.length > chunkChars) {
      flush()
      for (let i = 0; i < paragraph.length; i += chunkChars - overlap) {
        chunks.push({ idx: chunks.length, text: paragraph.slice(i, i + chunkChars).trim() })
      }
      buffer = ''
      continue
    }
    if (buffer.length + paragraph.length + 2 > chunkChars) flush()
    buffer += `${paragraph}\n\n`
  }
  flush()

  return chunks.filter((c) => c.text.length > 0).map((c, idx) => ({ idx, text: c.text }))
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was',
  'were', 'be', 'been', 'it', 'this', 'that', 'these', 'those', 'as', 'at', 'by', 'from', 'what',
  'which', 'who', 'how', 'why', 'when', 'where', 'do', 'does', 'did', 'can', 'could', 'would',
  'should', 'i', 'you', 'me', 'my', 'your', 'about', 'please', 'tell', 'give', 'explain',
])

function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  )
}

/**
 * Picks the chunks most relevant to `question`, up to `maxChars`.
 *
 * Scored by term overlap, normalised by chunk length so a long chunk does not win
 * on volume alone. Selected chunks are re-sorted into document order before being
 * joined -- reading them out of order is worse than reading fewer of them.
 *
 * With no usable question (or no overlap at all) it falls back to the start of
 * the document, which is where abstracts, titles, and summaries live.
 */
export function selectChunks(chunks: Chunk[], question: string, maxChars: number): Chunk[] {
  if (chunks.length === 0) return []

  const wanted = terms(question)
  const take = (ordered: Chunk[]): Chunk[] => {
    const picked: Chunk[] = []
    let total = 0
    for (const chunk of ordered) {
      if (total + chunk.text.length > maxChars) {
        if (picked.length > 0) break
        // Even the first chunk is over budget: include a truncated head so the
        // model gets something rather than nothing.
        picked.push({ idx: chunk.idx, text: chunk.text.slice(0, maxChars) })
        break
      }
      picked.push(chunk)
      total += chunk.text.length
    }
    return picked.sort((a, b) => a.idx - b.idx)
  }

  if (wanted.size === 0) return take(chunks)

  const scored = chunks
    .map((chunk) => {
      const chunkTerms = terms(chunk.text)
      let hits = 0
      for (const term of wanted) if (chunkTerms.has(term)) hits++
      return { chunk, score: hits / Math.sqrt(chunk.text.length || 1) }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) return take(chunks)
  return take(scored.map((s) => s.chunk))
}

export interface DocumentContext {
  /** The delimited block to prepend to the user's turn. */
  text: string
  /** Files whose text could not be read, for a note to the user. */
  unavailable: string[]
}

/**
 * Builds the document-context block for a turn's PDF attachments.
 *
 * The delimiters matter: without them a model treats pasted document text as if
 * the *user* wrote it, and instructions inside an attached document start looking
 * like instructions from the user. Naming the file and marking the boundaries
 * keeps attached content addressable as data.
 */
export async function buildDocumentContext(
  bucket: R2Bucket,
  files: FileRow[],
  question: string,
  maxChars: number,
): Promise<DocumentContext> {
  const pdfs = files.filter((f) => f.file_type === 'pdf')
  if (pdfs.length === 0) return { text: '', unavailable: [] }

  // Split the budget between documents so one long PDF cannot crowd out the rest.
  const perFile = Math.max(1_000, Math.floor(maxChars / pdfs.length))
  const blocks: string[] = []
  const unavailable: string[] = []

  for (const file of pdfs) {
    if (!file.extracted_text_key) {
      unavailable.push(file.original_filename)
      continue
    }
    const text = await loadExtractedText(bucket, file.extracted_text_key)
    if (!text) {
      unavailable.push(file.original_filename)
      continue
    }

    const chunks = chunkText(text)
    const selected = selectChunks(chunks, question, perFile)
    const excerpt = selected.map((c) => c.text).join('\n\n[...]\n\n')
    const partial = selected.length < chunks.length

    blocks.push(
      [
        `--- BEGIN ATTACHED DOCUMENT: ${file.original_filename} ---`,
        partial
          ? `(Excerpt: ${selected.length} of ${chunks.length} sections, selected as most relevant to the question.)`
          : '(Complete extracted text.)',
        '',
        excerpt,
        `--- END ATTACHED DOCUMENT: ${file.original_filename} ---`,
      ].join('\n'),
    )
  }

  if (blocks.length === 0) return { text: '', unavailable }

  return {
    text: [
      'The user attached the following document(s). Use them to answer, and say so if the answer is not in them.',
      '',
      ...blocks,
    ].join('\n'),
    unavailable,
  }
}

/**
 * Reads an image out of R2 as a data URL.
 *
 * Data URLs rather than links because our objects are deliberately not publicly
 * reachable -- there is no URL we could hand a model provider that would not
 * either be public or carry a credential.
 */
export async function imageDataUrl(bucket: R2Bucket, file: FileRow): Promise<string | null> {
  const object = await bucket.get(file.r2_key)
  if (!object) return null
  const bytes = new Uint8Array(await object.arrayBuffer())
  return `data:${file.mime_type};base64,${base64(bytes)}`
}

/** Chunked base64 -- `String.fromCharCode(...bytes)` blows the stack on an MB. */
function base64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
