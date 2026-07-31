/**
 * Firebase Auth, initialised lazily.
 *
 * Google sign-in only, matching the decision in PHASE2-PLAN.md §4.2. Everything
 * here is about *obtaining* an ID token; nothing here decides what the token is
 * allowed to do. Roles, suspension, and quotas all come from the D1 record the
 * Worker returns from `POST /api/auth/session` — see `auth.tsx`.
 *
 * ## Lazy on purpose
 *
 * `initializeApp` is not called at module load. Two reasons:
 *
 * 1. A deployment with no `VITE_FIREBASE_*` values should render a *readable
 *    setup message*, not a white screen from a throw during module evaluation.
 * 2. The Firebase SDK is a large chunk. Importing it from an async boundary lets
 *    Vite split it out, so the login screen paints before it downloads — and the
 *    3 MB gzipped Worker bundle ceiling on the Free plan has real headroom.
 */

import type { Auth, User } from 'firebase/auth'

export interface FirebaseSettings {
  apiKey: string
  authDomain: string
  projectId: string
  appId: string
  messagingSenderId?: string
}

/** Reads the build vars, returning null when the project has not been set up. */
export function firebaseSettings(): FirebaseSettings | null {
  const env = import.meta.env
  const apiKey = env.VITE_FIREBASE_API_KEY?.trim()
  const projectId = env.VITE_FIREBASE_PROJECT_ID?.trim()
  const appId = env.VITE_FIREBASE_APP_ID?.trim()
  if (!apiKey || !projectId || !appId) return null

  return {
    apiKey,
    // Derivable from the project id, so it is optional in `.env.local` — one
    // fewer value to copy wrong. An explicit setting still wins, which matters
    // for a custom auth domain.
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN?.trim() || `${projectId}.firebaseapp.com`,
    projectId,
    appId,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim() || undefined,
  }
}

export function isFirebaseConfigured(): boolean {
  return firebaseSettings() !== null
}

/** Names of the vars that are missing, for the setup message. */
export function missingFirebaseVars(): string[] {
  const env = import.meta.env
  const missing: string[] = []
  if (!env.VITE_FIREBASE_API_KEY?.trim()) missing.push('VITE_FIREBASE_API_KEY')
  if (!env.VITE_FIREBASE_PROJECT_ID?.trim()) missing.push('VITE_FIREBASE_PROJECT_ID')
  if (!env.VITE_FIREBASE_APP_ID?.trim()) missing.push('VITE_FIREBASE_APP_ID')
  return missing
}

export class FirebaseNotConfiguredError extends Error {
  readonly missing: string[]

  constructor(missing: string[]) {
    super(
      `Firebase is not configured. Copy .env.local.example to .env.local and fill in: ${missing.join(', ')}.`,
    )
    this.name = 'FirebaseNotConfiguredError'
    this.missing = missing
  }
}

let authPromise: Promise<Auth> | null = null

/**
 * The one `Auth` instance, created on first use.
 *
 * The promise is cached rather than the resolved value so concurrent callers
 * during startup share a single `initializeApp` — React 19 in StrictMode mounts
 * effects twice in development, and two initialisations would warn.
 */
export function getFirebaseAuth(): Promise<Auth> {
  if (authPromise) return authPromise

  const settings = firebaseSettings()
  if (!settings) return Promise.reject(new FirebaseNotConfiguredError(missingFirebaseVars()))

  authPromise = (async () => {
    const [{ initializeApp, getApps, getApp }, { getAuth, setPersistence, browserLocalPersistence }] =
      await Promise.all([import('firebase/app'), import('firebase/auth')])

    const app = getApps().length > 0 ? getApp() : initializeApp(settings)
    const auth = getAuth(app)

    // IndexedDB-backed, which is Firebase's default for browsers — stated
    // explicitly so a reload keeping the user signed in is a decision in the
    // code rather than an inherited default someone has to go and look up.
    try {
      await setPersistence(auth, browserLocalPersistence)
    } catch {
      // Private-browsing modes can refuse IndexedDB. In-memory persistence
      // still works for the current tab, so sign-in is degraded, not broken.
    }
    return auth
  })().catch((err) => {
    // Do not cache a failure: a transient chunk-load error should not make
    // sign-in permanently unavailable for the rest of the page's life.
    authPromise = null
    throw err
  })

  return authPromise
}

/**
 * Signs in with Google via a popup, falling back to a redirect.
 *
 * Popups are the better experience — the app keeps its state, and a cancelled
 * popup is a recoverable error rather than a full page load. But they are
 * blocked outright in some embedded webviews and by some privacy settings, and
 * in those cases the redirect flow is the only one that works.
 */
export async function signInWithGoogle(): Promise<void> {
  const auth = await getFirebaseAuth()
  const { GoogleAuthProvider, signInWithPopup, signInWithRedirect } = await import('firebase/auth')

  const provider = new GoogleAuthProvider()
  // Always show the chooser. Without this, someone signed into several Google
  // accounts is silently put into whichever one the browser saw last, which is
  // confusing when the wrong one is the one with admin access.
  provider.setCustomParameters({ prompt: 'select_account' })

  try {
    await signInWithPopup(auth, provider)
  } catch (err) {
    const code = errorCode(err)
    // The user closing the popup is not a failure worth reporting.
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      await signInWithRedirect(auth, provider)
      return
    }
    throw err
  }
}

export async function signOutFirebase(): Promise<void> {
  const auth = await getFirebaseAuth()
  const { signOut } = await import('firebase/auth')
  await signOut(auth)
}

/** Firebase's `code` field, when the thrown value has one. */
export function errorCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
}

/**
 * Turns a Firebase error into something worth showing a person.
 *
 * The raw messages are developer-facing ("Firebase: Error (auth/…)"), and the
 * two that users actually hit — an unauthorised domain and a disabled provider —
 * are both setup mistakes whose fix is a specific click in the Firebase console.
 */
export function describeAuthError(err: unknown): string {
  if (err instanceof FirebaseNotConfiguredError) return err.message

  switch (errorCode(err)) {
    case 'auth/unauthorized-domain':
      return `This domain is not authorised for sign-in. Add ${location.hostname} under Firebase console → Authentication → Settings → Authorized domains.`
    case 'auth/operation-not-allowed':
      return 'Google sign-in is not enabled for this Firebase project. Enable it under Authentication → Sign-in method.'
    case 'auth/network-request-failed':
      return 'Could not reach Google to sign in. Check your connection and try again.'
    case 'auth/too-many-requests':
      return 'Too many sign-in attempts. Wait a moment and try again.'
    case 'auth/invalid-api-key':
    case 'auth/api-key-not-valid-please-pass-a-valid-api-key':
      return 'The Firebase API key is not valid for this project. Check VITE_FIREBASE_API_KEY in .env.local.'
    case 'auth/user-disabled':
      return 'This Google account has been disabled.'
    default:
      return err instanceof Error && err.message ? err.message : 'Sign-in failed. Try again.'
  }
}

export type { Auth, User }
