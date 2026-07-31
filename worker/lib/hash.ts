/**
 * Hashing and signing, all on WebCrypto -- no dependencies, works in a Worker.
 *
 * Three jobs:
 *  - `ipHash` for privacy-preserving correlation in the audit log,
 *  - `sha256Hex` for file integrity,
 *  - HMAC sign/verify for short-lived file-view URLs (§6.4 of PHASE2-PLAN.md).
 */

const encoder = new TextEncoder()

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes =
    typeof data === 'string'
      ? encoder.encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data)
  // `as BufferSource` keeps TS happy across the Uint8Array<ArrayBufferLike> split.
  return toHex(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

/**
 * A salted, truncated hash of the client IP.
 *
 * Raw addresses are never written anywhere. 128 bits of a salted SHA-256 is
 * plenty to answer "were these two events from the same origin?" while not
 * being reversible to an address, and rotating `IP_HASH_SALT` deliberately
 * breaks correlation with everything logged before the rotation.
 *
 * Returns `undefined` when there is no salt, so a misconfigured deployment
 * stores nothing rather than storing an unsalted (i.e. brute-forceable) hash.
 */
export async function ipHash(request: Request, salt: string | undefined): Promise<string | undefined> {
  const ip = clientIp(request)
  if (!ip || !salt) return undefined
  return (await sha256Hex(`${ip}|${salt}`)).slice(0, 32)
}

export function clientIp(request: Request): string | undefined {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    undefined
  )
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

export async function hmacSign(secret: string, payload: string): Promise<string> {
  const key = await hmacKey(secret)
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(payload) as BufferSource))
}

/**
 * Verifies an HMAC. Uses `crypto.subtle.verify` rather than comparing strings,
 * so the comparison is constant-time and a signature cannot be guessed byte by
 * byte from response timings.
 */
export async function hmacVerify(secret: string, payload: string, signatureHex: string): Promise<boolean> {
  if (!/^[0-9a-f]+$/i.test(signatureHex) || signatureHex.length % 2 !== 0) return false
  const bytes = new Uint8Array(signatureHex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(signatureHex.slice(i * 2, i * 2 + 2), 16)
  }
  const key = await hmacKey(secret)
  return crypto.subtle.verify('HMAC', key, bytes as BufferSource, encoder.encode(payload) as BufferSource)
}

export function newId(): string {
  return crypto.randomUUID()
}
