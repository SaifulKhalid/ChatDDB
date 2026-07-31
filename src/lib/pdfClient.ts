/**
 * PDF text extraction in the browser.
 *
 * Workers Free gives 10 ms CPU per request, which is not enough to parse a PDF
 * server-side, so `PDF_EXTRACT_MODE=client` pushes the work to the browser.
 * pdf.js runs as a Web Worker spawned from the bundle (CSP-safe).
 */

import * as pdfjs from 'pdfjs-dist'

pdfjs.GlobalWorkerOptions.workerSrc =
  new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

const MAX_PAGES = 50
const MAX_CHARS = 1_500_000

export interface Extraction {
  text: string
  pages: number
}

/**
 * Extracts text from a PDF file in the browser.
 *
 * Returns `null` for scanned PDFs or corrupt files — the upload still proceeds,
 * and the server records `processingStatus: 'pending'` so the user sees
 * "text not extracted" rather than a refusal.
 */
export async function extractPdfText(file: File): Promise<Extraction | null> {
  try {
    const data = new Uint8Array(await file.arrayBuffer())
    // No `isEvalSupported: false` here — pdf.js dropped its eval-based glyph
    // compiler in v5, so the option is gone from v6's API and nothing in the
    // library needs `'unsafe-eval'`. The `'wasm-unsafe-eval'` that
    // `public/_headers` does grant is what v6's WASM image decoders want; text
    // extraction never reaches them, but the grant keeps them from throwing.
    const doc = await pdfjs.getDocument({ data }).promise
    const pages = Math.min(doc.numPages, MAX_PAGES)
    const out: string[] = []
    let chars = 0

    for (let i = 1; i <= pages && chars < MAX_CHARS; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      // `items` mixes TextItem with TextMarkedContent; only the former has `str`.
      const text = content.items.map((it) => ('str' in it ? it.str : '')).join(' ')
      out.push(`\n\n--- Page ${i} ---\n${text}`)
      chars += text.length
      page.cleanup()
    }

    await doc.loadingTask.destroy()
    return { text: out.join('').slice(0, MAX_CHARS), pages }
  } catch {
    return null
  }
}
