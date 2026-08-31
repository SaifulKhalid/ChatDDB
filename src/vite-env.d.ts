/// <reference types="vite/client" />

/**
 * Build-time configuration, inlined into the bundle by Vite.
 *
 * Every one of these is **public by design**. A Firebase web API key is an
 * identifier for a project, not a credential: it authorises nothing on its own,
 * and Google publishes it in their own quickstart snippets. What actually
 * protects the backend is that the Worker verifies the resulting ID token's
 * signature against Google's JWKS and checks its `aud`/`iss` against
 * `FIREBASE_PROJECT_ID`.
 *
 * So: do not "fix" this by moving these server-side. Hiding them would break the
 * client and secure nothing. The real secrets — `PROVIDER_API_KEY`,
 * `FILE_URL_SECRET`, `IP_HASH_SALT` — live in Worker secrets and never reach a
 * browser.
 */
interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY?: string
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string
  readonly VITE_FIREBASE_PROJECT_ID?: string
  readonly VITE_FIREBASE_APP_ID?: string
  /** Optional; only needed if Firebase Storage or Analytics are ever added. */
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
