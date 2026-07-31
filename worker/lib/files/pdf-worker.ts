/**
 * PDF text extraction, worker mode -- the target architecture.
 *
 * ## Not enabled by default, and why
 *
 * This is the preferred design (and what Cloudflare's own R2 tutorial does), but
 * it **requires the Workers Paid plan**. Free allows 10 ms of CPU per request;
 * PDF.js parsing costs hundreds of milliseconds to seconds per document, so on
 * Free this path reliably dies with error 1102 partway through page one. unpdf
 * also adds roughly 1.6 MB to a 3 MB gzipped bundle ceiling.
 *
 * ## Turning it on
 *
 * 1. Upgrade to Workers Paid (30 s CPU, Queues available).
 * 2. `npm install unpdf`
 * 3. Uncomment the import and the body of `extractWithUnpdf` below.
 * 4. Set `PDF_EXTRACT_MODE=worker` in wrangler.jsonc.
 * 5. `npm run build` and check the bundle size warning.
 *
 * The interface either mode satisfies is `ClientExtraction` from
 * `pdf-client.ts` -- `{text, pages}` -- so the call site in `routes/files.ts`
 * does not branch beyond choosing the extractor. Rows record which mode produced
 * them in `extraction_source`, so anything extracted on the client can be
 * re-extracted properly after the upgrade and told apart until it is.
 */

// Deliberately commented out: importing unpdf would pull ~1.6 MB into the
// bundle even on the Free plan, where this function can never run.
// import { extractText, getDocumentProxy } from 'unpdf'

import { serverError } from '../http.ts'
import { normaliseText, type ClientExtraction } from './pdf-client.ts'

export function isWorkerExtractionAvailable(): boolean {
  // Flips to `true` with the import above. Kept as a function so `routes/files.ts`
  // can fall back cleanly instead of throwing at module load.
  return false
}

/**
 * Extracts text from PDF bytes inside the Worker.
 *
 * @param bytes the PDF, already validated by `detect.ts`
 * @param maxPages page ceiling from `PDF_MAX_PAGES`, so one enormous document
 *   cannot consume the whole CPU budget even on Paid
 */
export async function extractWithUnpdf(bytes: Uint8Array, maxPages: number): Promise<ClientExtraction> {
  if (!isWorkerExtractionAvailable()) {
    throw serverError(
      'Worker-side PDF extraction is not enabled in this build. Install unpdf and uncomment the ' +
        'import in worker/lib/files/pdf-worker.ts, or leave PDF_EXTRACT_MODE=client.',
      'extraction_unavailable',
    )
  }

  /* Uncomment together with the import above.

  const pdf = await getDocumentProxy(bytes)
  const pages = Math.min(pdf.numPages, maxPages)
  const { text } = await extractText(pdf, { mergePages: false })
  const slice = Array.isArray(text) ? text.slice(0, pages) : [String(text)]
  return {
    text: normaliseText(slice.join('\n\n')),
    pages: pdf.numPages,
  }

  */

  // Unreachable while `isWorkerExtractionAvailable()` returns false; present so
  // the signature type-checks and the params are not flagged as unused.
  void bytes
  void maxPages
  void normaliseText
  throw serverError('Unreachable: worker extraction disabled.', 'extraction_unavailable')
}
