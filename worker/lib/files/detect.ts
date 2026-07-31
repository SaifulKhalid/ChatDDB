/**
 * Upload type validation.
 *
 * The client's `Content-Type` and filename are **hints**, never decisions.
 * Every accept/reject here is made from the bytes plus the size, and a file
 * whose sniffed type disagrees with its extension is rejected rather than
 * quietly corrected -- a mismatch is either a broken client or someone probing
 * what gets through, and both are worth an error.
 *
 * ## What this is not
 *
 * This is type confinement, not antivirus. A malicious PDF is still a malicious
 * PDF; what we guarantee is that it is *actually* a PDF, that nothing here can
 * execute it, that it comes back with `Content-Disposition: attachment` and
 * `nosniff`, and that it lives under a key only its owner can mint a URL for.
 * Real scanning needs an external service (noted as future work in the plan).
 */

import { badRequest, tooLarge } from '../http.ts'
import type { FileType } from '../../db/files.ts'

export interface DetectedType {
  fileType: FileType
  /** The sniffed MIME type, which is what gets stored and served back. */
  mimeType: string
  extension: string
}

/**
 * Magic-byte signatures. `null` in a pattern is a wildcard byte.
 *
 * SVG is deliberately absent, and not by oversight: SVG is an XML document that
 * can carry `<script>`, and "attach an image to a chat" never needs it. There is
 * no sniffable signature for it either -- it is just text -- so allowing it would
 * mean trusting the extension for exactly the one format where that is unsafe.
 */
const SIGNATURES: { pattern: (number | null)[]; mimeType: string; fileType: FileType; extensions: string[] }[] = [
  {
    // \x89 P N G \r \n \x1a \n
    pattern: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    mimeType: 'image/png',
    fileType: 'image',
    extensions: ['png'],
  },
  {
    // JPEG SOI + marker. All JPEG variants (JFIF, Exif) share this prefix.
    pattern: [0xff, 0xd8, 0xff],
    mimeType: 'image/jpeg',
    fileType: 'image',
    extensions: ['jpg', 'jpeg'],
  },
  {
    // R I F F ? ? ? ? W E B P -- the four size bytes are the wildcards.
    pattern: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
    mimeType: 'image/webp',
    fileType: 'image',
    extensions: ['webp'],
  },
  {
    // % P D F -
    pattern: [0x25, 0x50, 0x44, 0x46, 0x2d],
    mimeType: 'application/pdf',
    fileType: 'pdf',
    extensions: ['pdf'],
  },
]

export const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'pdf'] as const

/** Bytes needed to identify every supported format. */
export const SNIFF_BYTES = 16

function matches(bytes: Uint8Array, pattern: (number | null)[]): boolean {
  if (bytes.length < pattern.length) return false
  for (let i = 0; i < pattern.length; i++) {
    const expected = pattern[i]
    if (expected !== null && bytes[i] !== expected) return false
  }
  return true
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot === -1 || dot === filename.length - 1) return ''
  return filename.slice(dot + 1).toLowerCase()
}

/**
 * Identifies a file from its leading bytes and cross-checks the extension.
 *
 * Throws a 400 with an actionable message for anything unsupported -- the
 * upload UI surfaces these verbatim.
 */
export function detectType(head: Uint8Array, originalFilename: string): DetectedType {
  const extension = extensionOf(originalFilename)

  const signature = SIGNATURES.find((s) => matches(head, s.pattern))
  if (!signature) {
    if (extension === 'svg') {
      throw badRequest(
        'SVG files are not supported. They can contain scripts, so ChatDDB accepts PNG, JPEG, WebP, and PDF only.',
        'unsupported_type',
      )
    }
    throw badRequest(
      'This file type is not supported. Attach a PNG, JPEG, WebP, or PDF.',
      'unsupported_type',
    )
  }

  if (!signature.extensions.includes(extension)) {
    throw badRequest(
      `This file's contents (${signature.mimeType}) do not match its .${extension || '?'} extension. ` +
        'Rename it to the correct extension and try again.',
      'type_mismatch',
    )
  }

  return { fileType: signature.fileType, mimeType: signature.mimeType, extension }
}

/** Enforces the per-type size ceiling once the real byte count is known. */
export function checkSize(fileType: FileType, size: number, maxImageBytes: number, maxPdfBytes: number): void {
  if (size === 0) throw badRequest('That file is empty.', 'empty_file')
  const max = fileType === 'image' ? maxImageBytes : maxPdfBytes
  if (size > max) {
    throw tooLarge(
      `This ${fileType === 'image' ? 'image' : 'PDF'} is ${formatBytes(size)}, over the ` +
        `${formatBytes(max)} limit.`,
      'file_too_large',
    )
  }
}

/**
 * Reduces a client filename to something safe to store and echo.
 *
 * Strips any directory component (including Windows separators and `..`), keeps
 * only a conservative character set, and bounds the length. The result is what
 * goes in `filename`; the untouched original is kept separately for display and
 * is escaped by React on render.
 */
export function sanitiseFilename(original: string): string {
  const base = original.split(/[/\\]/).pop() ?? 'file'
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '') // no leading dots: no hidden files, no ".."
    .slice(0, 120)
  return cleaned.length > 0 ? cleaned : 'file'
}

/**
 * The R2 object key.
 *
 * `u/<userId>/<yyyy>/<mm>/<fileId>.<ext>` -- user-scoped, so a key on its own
 * grants nothing (access needs a signed URL minted for the owner) and per-user
 * usage is a prefix listing rather than a query.
 */
export function r2Key(userId: string, fileId: string, extension: string, now = new Date()): string {
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `u/${userId}/${year}/${month}/${fileId}.${extension}`
}

/** R2 key for the extracted text side-car of a PDF. */
export function textKey(fileKey: string): string {
  return `${fileKey}.txt`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
