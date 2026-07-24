/**
 * PDF text extraction using unpdf (works in Workers runtime).
 */
import { extractText, getDocumentProxy } from "unpdf";

export async function extractPdfText(buf: ArrayBuffer): Promise<string> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    // Truncate to a reasonable context window to avoid token explosion.
    const max = 24000;
    if (text.length > max) {
      return text.slice(0, max) + "\n\n[... document truncated ...]";
    }
    return text.trim();
  } catch (err) {
    return `[PDF text extraction failed: ${(err as Error).message}]`;
  }
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

export function classifyAttachment(contentType: string, name: string): "image" | "pdf" | "file" {
  if (isImage(contentType, name)) return "image";
  if (isPdf(contentType, name)) return "pdf";
  return "file";
}