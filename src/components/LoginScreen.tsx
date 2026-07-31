/**
 * The sign-in gate.
 *
 * Rendered *instead of* the chat UI, not on top of it — no chat component
 * mounts, no request is attempted, and there is no half-usable state to reason
 * about while signed out.
 *
 * The privacy notice sits **above** the button on purpose (PHASE2-PLAN.md §8.1):
 * telling someone their conversations may be reviewed after they have signed in
 * is not disclosure, it is an apology. It is plain prose rather than a checkbox
 * because a checkbox implies a choice that does not exist here — using the app
 * means the data is stored.
 */

import { AlertCircle, Loader2, Moon, ShieldCheck, Sun } from 'lucide-react'
import { useAuth } from '../lib/auth'
import type { Theme } from '../lib/theme'

export function LoginScreen({
  theme,
  onToggleTheme,
}: {
  theme: Theme
  onToggleTheme: () => void
}) {
  const { signIn, busy, error, unconfigured, missingVars } = useAuth()

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-surface">
      <header className="flex items-center justify-end p-3">
        <button
          onClick={onToggleTheme}
          className="rounded-lg p-2 text-ink-2 hover:bg-surface-3 hover:text-ink"
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title="Toggle theme"
        >
          {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
        </button>
      </header>

      <main className="flex flex-1 items-center justify-center px-5 pb-16">
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center text-center">
            <img
              src="/MotherCompanyLogo.jpg"
              alt="LabDDB"
              className="h-16 w-auto"
            />
            <h1 className="mt-5 text-2xl font-semibold tracking-tight">Welcome to ChatDDB</h1>
            <p className="mt-3 text-sm text-ink-2">
              Sign in to start chatting. Your conversations are saved to your account.
            </p>
          </div>

          {unconfigured ? (
            <SetupNotice missing={missingVars} />
          ) : (
            <>
              <PrivacyNotice />

              <button
                onClick={() => void signIn()}
                disabled={busy}
                className="mt-5 flex w-full items-center justify-center gap-3 rounded-full border border-line bg-surface px-4 py-3 text-sm font-medium text-ink transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? (
                  <Loader2 size={18} className="animate-spin" aria-hidden="true" />
                ) : (
                  <GoogleMark />
                )}
                {busy ? 'Signing in…' : 'Continue with Google'}
              </button>
            </>
          )}

          {error && (
            <div
              role="alert"
              className="mt-4 flex gap-2.5 rounded-xl border border-line bg-surface-2 p-3 text-sm text-ink-2"
            >
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-500" aria-hidden="true" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

function PrivacyNotice() {
  return (
    <div className="mt-7 rounded-xl border border-accent/20 bg-accent/[0.06] p-4 text-left text-xs leading-relaxed">
      <p className="mb-1 flex items-center gap-1.5 font-medium text-ink">
        <ShieldCheck size={14} className="text-accent" aria-hidden="true" />
        Your privacy matters to us
      </p>
      <p className="text-ink-2">
        Your conversations are stored securely and are yours to control. In rare cases,
        administrators may need to review activity for service maintenance &mdash; every such
        access is permanently logged. Full details in our{' '}
        <a
          href="/privacy.html"
          target="_blank"
          rel="noreferrer"
          className="text-accent underline underline-offset-2 hover:no-underline"
        >
          privacy notice
        </a>
        .
      </p>
    </div>
  )
}

/**
 * Shown when the build has no `VITE_FIREBASE_*` values.
 *
 * A dead "Continue with Google" button would be the worse failure: it looks like
 * the app is broken rather than unconfigured, and the fix is not discoverable
 * from the browser. So the screen states which variables are missing and where
 * they go.
 */
function SetupNotice({ missing }: { missing: string[] }) {
  return (
    <div className="mt-7 rounded-xl border border-line bg-surface-2 p-4 text-left text-sm text-ink-2">
      <p className="font-medium text-ink">Sign-in is not configured yet.</p>
      <p className="mt-2 text-xs leading-relaxed">
        Copy <code className="rounded bg-surface-3 px-1 py-0.5">.env.local.example</code> to{' '}
        <code className="rounded bg-surface-3 px-1 py-0.5">.env.local</code>, fill in the values from
        your Firebase project, and restart the dev server. Missing:
      </p>
      <ul className="mt-2 space-y-1 font-mono text-xs">
        {missing.map((name) => (
          <li key={name} className="text-ink">
            {name}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs leading-relaxed">
        These are public identifiers, not secrets — see <code>DOCS.md</code>.
      </p>
    </div>
  )
}

/** Google's four-colour mark. Inline so the button needs no network request. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65Z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59A14.5 14.5 0 0 1 9.77 24c0-1.6.27-3.15.76-4.59l-7.98-6.19A23.94 23.94 0 0 0 0 24c0 3.88.93 7.54 2.56 10.78l7.97-6.19Z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.9-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.17 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"
      />
    </svg>
  )
}
