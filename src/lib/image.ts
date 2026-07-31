/**
 * Prepares an image for upload by downscaling and re-encoding to WebP.
 *
 * Vision models have maximum edge sizes; a 4000×3000 photo from a phone
 * camera needs to be scaled down before it can be sent as a base64 image_url
 * part. This runs in the browser, before the upload, so the server never sees
 * the full-resolution original.
 */

const MAX_EDGE = 1568

/**
 * Optionally downscales and re-encodes an image file.
 *
 * Returns the original file unchanged if it is already small enough, is not
 * an image, or the re-encode would be larger than the original. Never throws
 * — the server validation is the authority on file type and size.
 */
export async function prepareImage(file: File, maxBytes: number): Promise<File> {
  if (!file.type.startsWith('image/')) return file

  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) return file

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  if (scale === 1 && file.size <= maxBytes) {
    bitmap.close()
    return file
  }

  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()

  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.85))
  if (!blob || blob.size >= file.size) return file

  const name = file.name.replace(/\.\w+$/, '') + '.webp'
  return new File([blob], name, { type: 'image/webp' })
}
