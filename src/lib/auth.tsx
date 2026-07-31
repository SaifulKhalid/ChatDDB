/**
 * Auth state for the whole app.
 *
 * Two identities are in play and keeping them distinct is the point:
 *
 * - **`firebaseUser`** — who Google says you are. Carries the ID token. Says
 *   nothing about what you may do here.
 * - **`profile`** — your row in D1, returned by `POST /api/auth/session`. This is
 *   where `role` and `status` come from, and it is the *only* place the client
 *   reads them. A token cannot claim to be an admin, because nothing in the app
 *   ever looks at the token's claims.
 *
 * The chat UI does not mount until `profile` exists (see `App.tsx`), so no
 * component below this one has to handle a null user.
 *
 * ## Why `POST /api/auth/session` is not called on every token change
 *
 * `onIdTokenChanged` fires on the hourly token refresh as well as on sign-in, and
 * that route writes a `login` row to `activity_logs`. Establishing the session
 * once per uid per page load keeps the audit trail meaning "someone signed in"
 * rather than "a token was renewed" — which is the difference between a useful
 * login history and a clock.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  configureApiClient,
  errorText,
  ApiError,
  apiJson,
  apiFetch,
} from './apiClient'
import {
  describeAuthError,
  getFirebaseAuth,
  isFirebaseConfigured,
  missingFirebaseVars,
  signInWithGoogle,
  signOutFirebase,
} from './firebase'
import type { User } from './firebase'
import type { MeResponse, ModelSpec, PublicUser, Quota, SessionResponse, UsageSummary } from './apiTypes'

/**
 * The live Firebase user, at module scope.
 *
 * `apiClient` needs a token from outside React — the streaming chat request and
 * the XHR upload are both plain functions. Registering the provider once here,
 * against a module variable the provider effect keeps current, avoids threading
 * a token getter through every call site (and avoids a stale closure capturing
 * last render's user).
 */
let currentUser: User | null = null
let notifySessionLost: (reason: string) => void = () => {}

configureApiClient({
  getToken: async (forceRefresh) => {
    if (!currentUser) return null
    try {
      return await currentUser.getIdToken(forceRefresh)
    } catch {
      // A revoked refresh token throws here. Returning null makes the caller
      // raise `NotSignedInError`, which the UI already knows how to show.
      return null
    }
  },
  onSessionLost: (reason) => notifySessionLost(reason),
})

export interface AuthState {
  /** True until Firebase has reported whether a session was restored. */
  initialising: boolean
  /** True while a sign-in or session exchange is in flight. */
  busy: boolean
  firebaseUser: User | null
  /** The D1 record. Null means "not signed in" as far as the app is concerned. */
  profile: PublicUser | null
  usage: UsageSummary | null
  quota: Quota | null
  models: ModelSpec[]
  /** Whether this deployment can generate images. Gates the composer toggle. */
  imageGeneration: boolean
  /** Sign-in or session-establishment failure, for the login screen. */
  error: string | null
  /** True when the `VITE_FIREBASE_*` build vars are absent. */
  unconfigured: boolean
  missingVars: string[]
  isAdmin: boolean
  signIn: () => Promise<void>
  signOut: () => Promise<void>
  /** Re-reads `GET /api/me`; call after anything that changes quota or usage. */
  refresh: () => Promise<void>
  clearError: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const unconfigured = !isFirebaseConfigured()

  // Nothing to wait for when there are no Firebase vars: go straight to the
  // login screen, which renders the setup instructions instead of a button.
  const [initialising, setInitialising] = useState(!unconfigured)
  const [busy, setBusy] = useState(false)
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<PublicUser | null>(null)
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [quota, setQuota] = useState<Quota | null>(null)
  const [models, setModels] = useState<ModelSpec[]>([])
  // Defaults to false so the toggle never flashes in on a slow /api/me and then
  // disappears once the real answer arrives.
  const [imageGeneration, setImageGeneration] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** uid whose `POST /api/auth/session` has already run this page load. */
  const establishedFor = useRef<string | null>(null)
  /** Guards against a resolved promise writing state after unmount. */
  const alive = useRef(true)

  const clearSession = useCallback(() => {
    establishedFor.current = null
    setProfile(null)
    setUsage(null)
    setQuota(null)
    setModels([])
    setImageGeneration(false)
  }, [])

  const loadMe = useCallback(async () => {
    const me = await apiJson<MeResponse>('/api/me')
    if (!alive.current) return
    setProfile(me.user)
    setUsage(me.usage)
    setQuota(me.quota)
    setModels(me.models)
    setImageGeneration(me.imageGeneration === true)
  }, [])

  /**
   * Exchanges the Firebase token for a ChatDDB session.
   *
   * A failure here signs the user *out of Firebase*, on purpose. Leaving them
   * holding a valid Google session that this app refuses would loop: every token
   * refresh would retry and fail, and the login screen would show a button that
   * cannot work. Signing out makes the state honest — with the reason preserved,
   * since the sign-out itself would otherwise clear it.
   */
  const establish = useCallback(
    async (user: User) => {
      setBusy(true)
      try {
        const token = await user.getIdToken()
        const res = await apiJson<SessionResponse>('/api/auth/session', {
          method: 'POST',
          auth: false,
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!alive.current) return
        establishedFor.current = user.uid
        setProfile(res.user)
        setError(null)
        // Quota, usage and the model registry are a second call because
        // /api/auth/session deliberately returns only the user record.
        await loadMe()
      } catch (err) {
        if (!alive.current) return
        clearSession()
        setError(sessionErrorText(err))
        // Fire-and-forget: the local state above is already correct, and a
        // failed sign-out must not replace the message explaining why.
        void signOutFirebase().catch(() => {})
      } finally {
        if (alive.current) setBusy(false)
      }
    },
    [clearSession, loadMe],
  )

  // Subscribe to Firebase. `onIdTokenChanged` rather than `onAuthStateChanged`
  // so `currentUser` is refreshed on token renewal too, not only sign-in/out.
  useEffect(() => {
    alive.current = true
    if (unconfigured) return

    let unsubscribe: (() => void) | undefined
    let cancelled = false

    void (async () => {
      try {
        const auth = await getFirebaseAuth()
        const { onIdTokenChanged } = await import('firebase/auth')
        if (cancelled) return

        unsubscribe = onIdTokenChanged(auth, (user) => {
          currentUser = user
          setFirebaseUser(user)
          setInitialising(false)

          if (!user) {
            clearSession()
            return
          }
          if (establishedFor.current !== user.uid) void establish(user)
        })
      } catch (err) {
        if (cancelled) return
        setInitialising(false)
        setError(describeAuthError(err))
      }
    })()

    return () => {
      cancelled = true
      alive.current = false
      unsubscribe?.()
    }
  }, [clearSession, establish, unconfigured])

  // A 401 that survived a token refresh, or a suspension noticed mid-session.
  useEffect(() => {
    notifySessionLost = (reason) => {
      if (!alive.current) return
      clearSession()
      if (reason === 'account_suspended') {
        setError(
          'This account has been suspended. Contact an administrator if you believe this is a mistake.',
        )
      } else {
        setError('Your session expired. Sign in again.')
      }
      void signOutFirebase().catch(() => {})
    }
    return () => {
      notifySessionLost = () => {}
    }
  }, [clearSession])

  const signIn = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      await signInWithGoogle()
      // The rest happens in the onIdTokenChanged handler above; `busy` stays
      // true through the redirect case because the page is about to unload.
    } catch (err) {
      if (alive.current) setError(describeAuthError(err))
    } finally {
      // Sign-in *starting* is done; `establish` sets its own busy window.
      if (alive.current) setBusy(false)
    }
  }, [])

  const signOut = useCallback(async () => {
    setBusy(true)
    try {
      // Best effort, and before the token goes away: this exists only so the
      // audit trail has a `logout` to pair with each `login`.
      await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
      await signOutFirebase()
      if (alive.current) {
        clearSession()
        setError(null)
      }
    } catch (err) {
      if (alive.current) setError(describeAuthError(err))
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [clearSession])

  const refresh = useCallback(async () => {
    if (!currentUser || !establishedFor.current) return
    try {
      await loadMe()
    } catch {
      // Usage counters going stale is not worth an error banner; the next
      // successful call will bring them up to date.
    }
  }, [loadMe])

  const clearError = useCallback(() => setError(null), [])

  const value = useMemo<AuthState>(
    () => ({
      initialising,
      busy,
      firebaseUser,
      profile,
      usage,
      quota,
      models,
      imageGeneration,
      error,
      unconfigured,
      missingVars: unconfigured ? missingFirebaseVars() : [],
      isAdmin: profile?.role === 'admin',
      signIn,
      signOut,
      refresh,
      clearError,
    }),
    [
      initialising,
      busy,
      firebaseUser,
      profile,
      usage,
      quota,
      models,
      imageGeneration,
      error,
      unconfigured,
      signIn,
      signOut,
      refresh,
      clearError,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/**
 * Explains a failed session exchange in terms of what to do about it.
 *
 * The two interesting cases are both *deployment* problems rather than user
 * mistakes, and both produce a bare 503/500 that says nothing useful on its own:
 * a Worker with no `FIREBASE_PROJECT_ID` cannot verify any token, and one with no
 * `DB` binding cannot create the user row.
 */
function sessionErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401 && err.type === 'invalid_token') {
      return 'Google signed you in, but this server rejected the token. Check that FIREBASE_PROJECT_ID in wrangler.jsonc matches VITE_FIREBASE_PROJECT_ID in .env.local.'
    }
    // `not_configured` (no FIREBASE_PROJECT_ID, no DB binding) already carries
    // the exact remedy in its message, so it passes through unaltered.
    return err.message
  }
  return errorText(err)
}
