/**
 * Signed view URLs for file attachments.
 *
 * `<img>` tags cannot send an `Authorization` header, so file views use a
 * 300-second HMAC-signed URL obtained from the worker. This module caches the
 * URL and re-mints it once when it is about to expire.
 */

import { useEffect, useRef, useState } from 'react'
import { apiJson } from './apiClient'
import type { SignedViewUrl } from './apiTypes'

const cache = new Map<string, SignedViewUrl>()

/**
 * Returns a usable view URL for the given file id.
 *
 * The cached URL is returned if it has at least 30 seconds of life remaining.
 * Otherwise a fresh one is minted.
 */
export async function viewUrl(fileId: string): Promise<string> {
  const hit = cache.get(fileId)
  if (hit && hit.expiresAt - Date.now() > 30_000) return hit.url
  const signed = await apiJson<SignedViewUrl>(`/api/files/${fileId}/url`)
  cache.set(fileId, signed)
  return signed.url
}

/** Removes a cached URL so the next call re-mints. */
export function invalidateViewUrl(fileId: string) {
  cache.delete(fileId)
}

/**
 * Resolves a stored image to a `src`, re-minting once if the link has expired.
 *
 * Shared by the attachment chip's thumbnail and the full-size generated image,
 * because the expiry behaviour is the fiddly part: a URL lives 300 seconds, a
 * conversation left open outlives that, and the resulting `onError` has to
 * invalidate and retry exactly once — retrying forever on a deleted file would
 * loop. One implementation keeps both call sites honest about that.
 *
 * Pass `enabled: false` for non-images so the hook still runs unconditionally
 * (as hooks must) without minting a URL that will never be used.
 */
export function useSignedImageUrl(fileId: string | undefined, enabled = true) {
  const [src, setSrc] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)
  /** Caps the re-mint at a single retry. */
  const retried = useRef(false)

  useEffect(() => {
    setBroken(false)
    retried.current = false
    if (!enabled || !fileId) {
      setSrc(null)
      return
    }
    let cancelled = false
    viewUrl(fileId)
      .then((url) => { if (!cancelled) setSrc(url) })
      .catch(() => { if (!cancelled) setBroken(true) })
    return () => { cancelled = true }
  }, [fileId, enabled])

  /** Hand to `<img onError>`: one re-mint, then give up. */
  function onError() {
    if (!fileId || retried.current) { setBroken(true); return }
    retried.current = true
    invalidateViewUrl(fileId)
    viewUrl(fileId).then(setSrc).catch(() => setBroken(true))
  }

  return { src, broken, onError }
}
