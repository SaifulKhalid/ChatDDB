/**
 * Firebase ID token verification.
 *
 * ## There is no Firebase Admin key in this system
 *
 * The Admin SDK is not used and no service-account JSON exists anywhere in the
 * project. A Firebase ID token is an RS256 JWT signed by Google, so verifying
 * it needs only Google's *public* key set. That is a deliberate security
 * property, not a shortcut: there is no admin private key here to leak, commit,
 * or rotate. The only configuration is `FIREBASE_PROJECT_ID`, which is public
 * information.
 *
 * `createRemoteJWKSet` caches the key set in module scope (so warm isolates do
 * no network I/O) and re-fetches on a `kid` it has not seen, which is exactly
 * how Google's key rotation is meant to be handled. Keys are never hardcoded.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { forbidden, notConfigured, unauthorized } from '../lib/http.ts'

/** Google's public key set for Firebase Auth ID tokens. */
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'

/**
 * Built once per isolate. Kept at module scope on purpose -- the whole point is
 * that a warm isolate verifies a token with zero subrequests.
 */
const jwks = createRemoteJWKSet(new URL(JWKS_URL))

/** Small clock skew allowance, in seconds, for `exp`/`iat`/`auth_time`. */
const CLOCK_TOLERANCE_S = 30

/** The verified claims we actually use. Nothing else is read from the token. */
export interface VerifiedToken {
  /** Firebase uid. The only identity input we trust from the client. */
  uid: string
  email: string
  emailVerified: boolean
  name?: string
  picture?: string
  /** Seconds since epoch when the user actually authenticated. */
  authTime?: number
}

interface FirebasePayload extends JWTPayload {
  email?: unknown
  email_verified?: unknown
  name?: unknown
  picture?: unknown
  auth_time?: unknown
  firebase?: { sign_in_provider?: unknown }
}

/** Pulls the bearer token out of the Authorization header. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const token = match?.[1]?.trim()
  return token && token.length > 0 ? token : null
}

/**
 * Verifies a Firebase ID token and returns its claims.
 *
 * Throws 401 for anything wrong with the token itself. The distinction matters:
 * a 401 tells the client to refresh and retry once, which is what
 * `src/lib/apiClient.ts` does when Firebase's one-hour token has expired.
 */
export async function verifyIdToken(token: string, projectId: string | undefined): Promise<VerifiedToken> {
  const project = projectId?.trim()
  if (!project) {
    // A configuration fault, not the caller's fault -- so 503, not 401. This is
    // the one place a 503 is correct: the service genuinely cannot do its job.
    throw notConfigured(
      'FIREBASE_PROJECT_ID is not set, so ID tokens cannot be verified. ' +
        'Add it to the vars in wrangler.jsonc (it is a public identifier, not a secret).',
    )
  }

  let payload: FirebasePayload
  try {
    const result = await jwtVerify(token, jwks, {
      // Firebase signs ID tokens for a project with the project id as audience
      // and securetoken.google.com/<project> as issuer. Both are checked here,
      // which is what stops a valid token from *another* Firebase project.
      issuer: `https://securetoken.google.com/${project}`,
      audience: project,
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_S,
    })
    payload = result.payload as FirebasePayload
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // Logged, but never echoed: the client gets a generic message so a probe
    // cannot learn *why* a forged token failed.
    console.warn('[chatddb] token rejected: %s', reason)
    throw unauthorized('Your session is invalid or has expired. Sign in again.', 'invalid_token')
  }

  const uid = typeof payload.sub === 'string' ? payload.sub.trim() : ''
  if (!uid) throw unauthorized('Token has no subject.', 'invalid_token')

  // `auth_time` is when the user actually authenticated. A value in the future
  // means a forged or clock-broken token; jose does not check this claim.
  const authTime = typeof payload.auth_time === 'number' ? payload.auth_time : undefined
  if (authTime !== undefined && authTime > Date.now() / 1000 + CLOCK_TOLERANCE_S) {
    throw unauthorized('Token authentication time is in the future.', 'invalid_token')
  }

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
  if (!email) {
    // Every provider we enable (Google only, for now) supplies an email, and
    // the users table requires one.
    throw forbidden('This account has no email address, which ChatDDB requires.', 'email_required')
  }

  return {
    uid,
    email,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : undefined,
    picture: typeof payload.picture === 'string' && payload.picture.trim() ? payload.picture.trim() : undefined,
    authTime,
  }
}
