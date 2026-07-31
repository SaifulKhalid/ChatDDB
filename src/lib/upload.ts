/**
 * File upload via XMLHttpRequest, the only way to get upload progress.
 *
 * Cannot go through `apiFetch` because fetch does not expose per-byte progress
 * on uploads. The bearer token is passed as an `Authorization` header.
 * Retries once on 401 with a force-refreshed token (mirrors `apiFetch`).
 */

import { ApiError, authToken } from './apiClient'
import type { PublicFile } from './apiTypes'
import type { Extraction } from './pdfClient'

export interface UploadOptions {
  file: File
  sessionId?: string
  extraction?: Extraction | null
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export async function uploadFile(opts: UploadOptions): Promise<PublicFile> {
  const token = await authToken()
  return attempt(token, opts).catch(async (err) => {
    if (err instanceof ApiError && err.status === 401) return attempt(await authToken(true), opts)
    throw err
  })
}

function attempt(token: string, o: UploadOptions): Promise<PublicFile> {
  return new Promise((resolve, reject) => {
    // An already-aborted signal never fires `abort`, so check it up front.
    if (o.signal?.aborted) return reject(abortError())

    const form = new FormData()
    form.append('file', o.file)
    if (o.sessionId) form.append('sessionId', o.sessionId)
    if (o.extraction) form.append('extraction', JSON.stringify(o.extraction))

    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/files')
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.responseType = 'text'

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) o.onProgress?.(e.loaded / e.total)
    }

    xhr.onload = () => {
      let body: any = null
      try { body = JSON.parse(xhr.responseText) } catch { /* non-JSON error page */ }
      if (xhr.status === 201 && body?.file) return resolve(body.file as PublicFile)
      reject(new ApiError(
        xhr.status,
        body?.error?.type ?? 'upload_failed',
        body?.error?.message ?? 'The upload failed.',
      ))
    }

    xhr.onerror = () => reject(new Error('The upload could not reach the server.'))
    xhr.ontimeout = () => reject(new Error('The upload timed out.'))
    // `xhr.abort()` fires `abort`, not `error`. Without this handler the promise
    // never settles, and the caller's sequential upload loop stalls on the
    // cancelled file instead of moving to the next one.
    xhr.onabort = () => reject(abortError())

    o.signal?.addEventListener('abort', () => xhr.abort(), { once: true })

    xhr.send(form)
  })
}

/** Matches what `fetch` rejects with on abort, so callers can treat both alike. */
function abortError(): Error {
  return new DOMException('The upload was cancelled.', 'AbortError')
}
