/**
 * PDF text extraction using unpdf (works in Workers runtime).
 * Supports chunked output for efficient LLM context usage.
 */
import { extractText, getDocumentProxy } from "unpdf";

/**
 * Rough token estimation: ~4 characters per token for English text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extract text from a PDF and return it as a single string.
 */
export async function extractPdfText(buf: ArrayBuffer): Promise<string> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    const max = 48000;
    return text.length > max
      ? text.slice(0, max) + "\n\n[... document truncated ...]"
      : text.trim();
  } catch (err) {
    return `[PDF text extraction failed: ${(err as Error).message}]`;
  }
}

/**
 * Chunk extracted text into retrievable pieces for efficient LLM context.
 * Each chunk targets 500-1000 tokens (2000-4000 characters).
 */
export function chunkText(
  text: string,
  maxChunkChars = 4000
): { text: string; tokenEstimate: number }[] {
  if (!text || text.length === 0) return [];

  const chunks: { text: string; tokenEstimate: number }[] = [];

  // Split on paragraph boundaries (double newlines) first
  const paragraphs = text.split(/\n\s*\n/);
  let current = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length > maxChunkChars && current.length > 0) {
      chunks.push({
        text: current.trim(),
        tokenEstimate: estimateTokens(current),
      });
      current = trimmed + "\n\n";
    } else {
      current += trimmed + "\n\n";
    }
  }

  if (current.trim().length > 0) {
    chunks.push({
      text: current.trim(),
      tokenEstimate: estimateTokens(current),
    });
  }

  return chunks;
}

/**
 * Build the context string from the first N chunks (typically 2-3).
 * Used for initial questions about a document.
 */
export function buildContextFromChunks(
  chunks: { text: string; tokenEstimate: number }[],
  maxChunks = 3
): string {
  const selected = chunks.slice(0, maxChunks);
  if (selected.length === 0) return "";
  return selected.map((c) => c.text).join("\n\n");
}

export function isPdf(contentType: string, name: string): boolean {
  return (
    contentType === "application/pdf" ||
    name.toLowerCase().endsWith(".pdf")
  );
}

export function isImage(contentType: string, name: string): boolean {
  return (
    contentType.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(name)
  );
}

export function classifyAttachment(
  contentType: string,
  name: string
): "image" | "pdf" | "file" {
  if (isImage(contentType, name)) return "image";
  if (isPdf(contentType, name)) return "pdf";
  return "file";
}