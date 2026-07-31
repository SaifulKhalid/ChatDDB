/**
 * File uploads, downloads, and signed view URLs.
 *
 *   POST   /api/files          multipart upload (validated by magic bytes)
 *   GET    /api/files          the caller's files
 *   GET    /api/files/:id      one file's metadata
 *   DELETE /api/files/:id      remove the row and the R2 object
 *   GET    /api/files/:id/url  mint a short-lived signed view URL
 *   GET    /api/files/view     serve bytes for a signed URL — **no auth header**
 *
 * ## Why `/view` is unauthenticated
 *
 * An `<img src>` cannot carry an `Authorization` header. The options are a
 * cookie (ambient credentials, and then CSRF actually applies), making the bucket
 * public (no), or a signed URL. So: `/api/files/:id/url` requires auth and proves
 * ownership, then returns a URL carrying an HMAC over `fileId|expiry`. `/view`
 * verifies that signature and nothing else. The URL is the capability, it lasts
 * five minutes, and it is unguessable without `FILE_URL_SECRET`.
 */

import { badRequest, forbidden, json, notFound, serverError, tooLarge, unauthorized } from '../lib/http.ts'
import { isUuid, parsePage } from '../lib/validate.ts'
import { requireBucket, requireDb } from '../db/client.ts'
import * as filesDb from '../db/files.ts'
import * as activity from '../db/activity.ts'
import * as ratelimit from '../lib/ratelimit.ts'
import * as suspicious from '../lib/suspicious.ts'
import {
  checkSize,
  detectType,
  formatBytes,
  r2Key,
  sanitiseFilename,
  SNIFF_BYTES,
  textKey,
} from '../lib/files/detect.ts'
import { parseClientExtraction, storeExtraction } from '../lib/files/pdf-client.ts'
import { extractWithUnpdf, isWorkerExtractionAvailable } from '../lib/files/pdf-worker.ts'
import { hmacSign, hmacVerify, newId, sha256Hex } from '../lib/hash.ts'
import type { AuthedContext, RequestContext } from '../auth/middleware.ts'

/** How long a signed view URL stays valid. Long enough to render, not to share. */
const VIEW_URL_TTL_S = 300

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function postUpload(ctx: AuthedContext): Promise<Response> {
  const bucket = requireBucket(ctx.env.FILES)
  await limitUpload(ctx)

  const ceiling = Math.max(ctx.policy.maxImageBytes, ctx.policy.maxPdfBytes)
  const declared = Number.parseInt(ctx.request.headers.get('content-length') ?? '', 10)
  // Refused from the header before the body is read, so an oversized upload
  // costs us nothing. The real byte count is checked again after decoding.
  if (Number.isFinite(declared) && declared > ceiling + 64 * 1024) {
    throw tooLarge(`That upload is larger than the ${formatBytes(ceiling)} limit.`, 'file_too_large')
  }

  const contentType = ctx.request.headers.get('content-type') ?? ''
  if (!contentType.includes('multipart/form-data')) {
    throw badRequest('Uploads must be `multipart/form-data`.', 'invalid_content_type')
  }

  let form: FormData
  try {
    form = await ctx.request.formData()
  } catch {
    throw badRequest('Could not read the upload. Try again.', 'invalid_multipart')
  }

  const entry = form.get('file')
  if (!(entry instanceof File)) throw badRequest('Attach the file in a `file` field.', 'missing_file')

  const originalFilename = entry.name || 'file'
  const bytes = new Uint8Array(await entry.arrayBuffer())

  const detected = await validate(ctx, bytes, originalFilename)

  const fileId = newId()
  const key = r2Key(ctx.user.id, fileId, detected.extension)
  const sessionId = readSessionId(form.get('sessionId'))

  // Row first, then the object, then promote the row. A crash in the middle
  // leaves a `pending` row pointing at a key that may not exist — prunable, and
  // never an *untracked* object, which is the failure that costs money quietly.
  await filesDb.createPending(ctx.db, {
    id: fileId,
    userId: ctx.user.id,
    sessionId,
    filename: sanitiseFilename(originalFilename),
    originalFilename: originalFilename.slice(0, 255),
    fileType: detected.fileType,
    mimeType: detected.mimeType,
    fileSize: bytes.length,
    r2Key: key,
    processingStatus: detected.fileType === 'pdf' ? 'pending' : 'none',
  })

  try {
    await bucket.put(key, bytes, {
      httpMetadata: {
        contentType: detected.mimeType,
        // Belt and braces with the header `/view` sets: even if an object were
        // somehow reached directly, it would not render as an active document.
        contentDisposition: `attachment; filename="${sanitiseFilename(originalFilename)}"`,
      },
      customMetadata: { userId: ctx.user.id, fileId },
    })
  } catch (err) {
    await filesDb.markFailed(ctx.db, fileId)
    console.error('[chatddb] R2 put failed for %s: %s', key, err)
    throw serverError('Could not store that file. Try again.', 'storage_failed')
  }

  await filesDb.markStored(ctx.db, fileId, await sha256Hex(bytes))

  const processing = await runExtraction(ctx, bucket, fileId, key, bytes, detected.fileType, form)

  ctx.exec.waitUntil(
    activity.log(ctx.db, {
      userId: ctx.user.id,
      action: 'file_uploaded',
      // Ids, types and sizes only — never the filename, which is user content.
      metadata: { fileId, type: detected.fileType, bytes: bytes.length, sessionId, processing },
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
    }),
  )

  const row = await filesDb.getOwned(ctx.db, fileId, ctx.user.id)
  if (!row) throw serverError('The upload was stored but could not be read back.', 'storage_inconsistent')
  return json({ file: filesDb.toPublicFile(row) }, 201, ctx.request, ctx.env)
}

/**
 * Validates the bytes, logging any refusal.
 *
 * Rejections are logged (as `suspicious_activity` with `reason:upload_rejected`)
 * because a *pattern* of them is the signal — one person renaming a `.gif` is
 * noise, forty attempts in an hour is someone mapping the validator.
 */
async function validate(ctx: AuthedContext, bytes: Uint8Array, filename: string) {
  const flagInput = { db: ctx.db, userId: ctx.user.id, ipHash: ctx.ipHash, userAgent: ctx.userAgent }
  try {
    const detected = detectType(bytes.subarray(0, SNIFF_BYTES), filename)
    checkSize(detected.fileType, bytes.length, ctx.policy.maxImageBytes, ctx.policy.maxPdfBytes)
    return detected
  } catch (err) {
    const why = err instanceof Error ? err.message : 'rejected'
    ctx.exec.waitUntil(
      suspicious
        .noteRejectedUpload(flagInput, why, { bytes: bytes.length })
        .then(() => suspicious.afterRejectedUpload(flagInput, why)),
    )
    throw err
  }
}

function readSessionId(value: File | string | null): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  // A bad id here is not worth failing an upload over: the file simply arrives
  // unattached, and `POST /api/chat` links it to the message that carries it.
  return isUuid(value) ? value : null
}

/**
 * Extracts PDF text, in whichever mode is configured.
 *
 * Client mode is the default because the Free plan's 10 ms CPU ceiling cannot
 * parse a PDF (see `pdf-client.ts`). Either way a failure is recorded on the row
 * and the upload still succeeds — a PDF whose text could not be read is still a
 * PDF the user uploaded, and the chat route tells the model it could not read it.
 */
async function runExtraction(
  ctx: AuthedContext,
  bucket: R2Bucket,
  fileId: string,
  key: string,
  bytes: Uint8Array,
  fileType: 'image' | 'pdf',
  form: FormData,
): Promise<string> {
  if (fileType !== 'pdf') return 'none'

  const raw = form.get('extraction')
  const clientText = parseClientExtraction(typeof raw === 'string' ? raw : null)

  try {
    if (ctx.policy.pdfExtractMode === 'worker' && isWorkerExtractionAvailable()) {
      const extracted = await extractWithUnpdf(bytes, ctx.policy.pdfMaxPages)
      const result = await storeExtraction(bucket, key, extracted, 'worker')
      await filesDb.saveExtraction(ctx.db, fileId, result)
      return result.status
    }

    if (clientText) {
      const result = await storeExtraction(bucket, key, clientText, 'client')
      await filesDb.saveExtraction(ctx.db, fileId, result)
      return result.status
    }

    // No text supplied and no server-side extractor: left pending, which the UI
    // shows as "text not extracted" rather than pretending the PDF is readable.
    return 'pending'
  } catch (err) {
    console.error('[chatddb] extraction failed for %s: %s', fileId, err)
    await filesDb.markProcessingFailed(ctx.db, fileId, 'failed')
    return 'failed'
  } finally {
    ctx.exec.waitUntil(
      activity.log(ctx.db, {
        userId: ctx.user.id,
        action: 'file_processed',
        metadata: { fileId, mode: ctx.policy.pdfExtractMode, hadClientText: clientText !== null },
        ipHash: ctx.ipHash,
        userAgent: ctx.userAgent,
      }),
    )
  }
}

async function limitUpload(ctx: AuthedContext): Promise<void> {
  const verdict = await ratelimit.consume(ctx.db, `user:${ctx.user.id}`, 'upload', [
    { kind: 'minute', max: ctx.policy.rateUploadPerMin },
    { kind: 'day', max: ctx.policy.rateUploadPerDay },
  ])
  if (verdict.allowed) return

  await activity.log(ctx.db, {
    userId: ctx.user.id,
    action: 'rate_limited',
    severity: 'warn',
    metadata: { action: 'upload', window: verdict.kind, limit: verdict.limit, count: verdict.count },
    ipHash: ctx.ipHash,
    userAgent: ctx.userAgent,
  })
  ctx.exec.waitUntil(
    suspicious.afterRateLimit(
      { db: ctx.db, userId: ctx.user.id, ipHash: ctx.ipHash, userAgent: ctx.userAgent },
      'upload',
    ),
  )
  ratelimit.enforce(verdict, 'uploads')
}

// ---------------------------------------------------------------------------
// Read and delete
// ---------------------------------------------------------------------------

export async function listFiles(ctx: AuthedContext): Promise<Response> {
  const { limit } = parsePage(ctx.url, 50, 200)
  const rows = await filesDb.listForUser(ctx.db, ctx.user.id, limit)
  return json({ files: rows.map(filesDb.toPublicFile) }, 200, ctx.request, ctx.env)
}

export async function getFile(ctx: AuthedContext, id: string): Promise<Response> {
  const row = await filesDb.getOwned(ctx.db, id, ctx.user.id)
  if (!row) throw notFound('That file does not exist.', 'file_not_found')
  return json({ file: filesDb.toPublicFile(row) }, 200, ctx.request, ctx.env)
}

/**
 * Deletes a file.
 *
 * R2 objects go first: an orphaned row is a cosmetic bug, an orphaned object is
 * a bill and a privacy problem. If the object delete fails the row stays, so a
 * retry (or `db:prune`) can finish the job.
 */
export async function deleteFile(ctx: AuthedContext, id: string): Promise<Response> {
  const row = await filesDb.getOwned(ctx.db, id, ctx.user.id)
  if (!row) throw notFound('That file does not exist.', 'file_not_found')

  const bucket = requireBucket(ctx.env.FILES)
  const keys = [row.r2_key, ...(row.extracted_text_key ? [row.extracted_text_key] : [])]
  try {
    await bucket.delete(keys)
  } catch (err) {
    console.error('[chatddb] R2 delete failed for %s: %s', row.r2_key, err)
    throw serverError('Could not delete that file. Try again.', 'storage_failed')
  }

  await filesDb.deleteOwned(ctx.db, id, ctx.user.id)
  ctx.exec.waitUntil(
    activity.log(ctx.db, {
      userId: ctx.user.id,
      action: 'file_deleted',
      metadata: { fileId: id, type: row.file_type, bytes: row.file_size },
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
    }),
  )
  return json({ ok: true }, 200, ctx.request, ctx.env)
}

// ---------------------------------------------------------------------------
// Signed view URLs
// ---------------------------------------------------------------------------

function viewSecret(env: { FILE_URL_SECRET?: string }): string {
  const secret = env.FILE_URL_SECRET?.trim()
  if (!secret) {
    // Refused rather than falling back to an unsigned URL: an unsigned view
    // route is an open bucket, which is exactly what this design avoids.
    throw serverError(
      'FILE_URL_SECRET is not set, so file view URLs cannot be signed. Run ' +
        '`npx wrangler secret put FILE_URL_SECRET` (any long random string).',
      'not_configured_files',
    )
  }
  return secret
}

/** Mints a signed, expiring URL for a file the caller owns. */
export async function getFileUrl(ctx: AuthedContext, id: string): Promise<Response> {
  const row = await filesDb.getOwned(ctx.db, id, ctx.user.id)
  if (!row) throw notFound('That file does not exist.', 'file_not_found')
  if (row.upload_status !== 'stored') {
    throw badRequest('That file has not finished uploading.', 'file_not_ready')
  }
  return json(await mintViewUrl(ctx.env, ctx.url.origin, row), 200, ctx.request, ctx.env)
}

export interface SignedViewUrl {
  url: string
  expiresAt: number
  mimeType: string
}

/**
 * Builds the signed URL for a file row.
 *
 * Exported because the admin file monitor needs the same capability, and it must
 * be the *same* signing path -- a second implementation is how one of them ends
 * up with a longer TTL or a forgotten expiry check. Ownership is the caller's
 * problem: `getFileUrl` proves it, and `routes/admin.ts` writes an audit row
 * instead.
 */
export async function mintViewUrl(
  env: { FILE_URL_SECRET?: string },
  origin: string,
  row: filesDb.FileRow,
): Promise<SignedViewUrl> {
  const expires = Math.floor(Date.now() / 1000) + VIEW_URL_TTL_S
  const signature = await hmacSign(viewSecret(env), `${row.id}|${expires}`)
  const url = new URL('/api/files/view', origin)
  url.searchParams.set('id', row.id)
  url.searchParams.set('exp', String(expires))
  url.searchParams.set('sig', signature)
  return { url: url.pathname + url.search, expiresAt: expires * 1000, mimeType: row.mime_type }
}

/**
 * Serves file bytes for a signed URL.
 *
 * Deliberately takes a `RequestContext`, not an `AuthedContext`: the signature
 * *is* the authorisation. Everything else about the response is defensive —
 * `nosniff`, an explicit disposition, and no CORS headers, because this is only
 * ever loaded same-origin by the app that minted the URL.
 */
export async function viewFile(ctx: RequestContext): Promise<Response> {
  const id = ctx.url.searchParams.get('id') ?? ''
  const exp = Number.parseInt(ctx.url.searchParams.get('exp') ?? '', 10)
  const sig = ctx.url.searchParams.get('sig') ?? ''

  if (!isUuid(id) || !Number.isFinite(exp) || !sig) {
    throw badRequest('That file link is malformed.', 'invalid_signature')
  }
  if (exp * 1000 < Date.now()) {
    // Its own type so the client can silently re-mint instead of showing an
    // error — an expired link during a long-open tab is expected, not a fault.
    throw unauthorized('That file link has expired.', 'expired_signature')
  }
  if (!(await hmacVerify(viewSecret(ctx.env), `${id}|${exp}`, sig))) {
    throw forbidden('That file link is not valid.', 'invalid_signature')
  }

  const db = requireDb(ctx.env.DB)
  const row = await filesDb.getAny(db, id)
  if (!row || row.upload_status !== 'stored') throw notFound('That file does not exist.', 'file_not_found')

  const object = await requireBucket(ctx.env.FILES).get(row.r2_key)
  if (!object) throw notFound('That file is no longer stored.', 'file_not_found')

  // Images inline so `<img>` works; PDFs as an attachment, because some viewers
  // execute scripts inside a PDF and an inline one is same-origin.
  const disposition = row.file_type === 'image' ? 'inline' : 'attachment'
  return new Response(object.body, {
    headers: {
      'Content-Type': row.mime_type,
      'Content-Length': String(row.file_size),
      'Content-Disposition': `${disposition}; filename="${row.filename}"`,
      'X-Content-Type-Options': 'nosniff',
      // Private and no longer than the signature is valid, so a shared cache can
      // never serve these bytes to anyone the URL was not minted for.
      'Cache-Control': `private, max-age=${VIEW_URL_TTL_S}`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  })
}

/**
 * Removes an orphan's bytes as well as its row. Used by `npm run db:prune`.
 *
 * `textKey(r2_key)` is tried alongside the recorded `extracted_text_key` because
 * a side-car can exist while the row's pointer to it does not: `storeExtraction`
 * puts the object before `saveExtraction` updates the row.
 */
export async function deleteObjects(bucket: R2Bucket, row: filesDb.FileRow): Promise<void> {
  const keys = new Set([row.r2_key, textKey(row.r2_key)])
  if (row.extracted_text_key) keys.add(row.extracted_text_key)
  await bucket.delete([...keys])
}
