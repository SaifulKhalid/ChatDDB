import { useTheme } from './lib/theme'
import { useAuth } from './lib/auth'
import { useRoute, navigate } from './lib/router'
import { LoginScreen } from './components/LoginScreen'
import { AdminPanel } from './components/admin/AdminPanel'
import { ChatApp } from './ChatApp'
import { Logo } from './components/Logo'
import { ArrowLeft } from 'lucide-react'

export default function App() {
  const { theme, toggleTheme } = useTheme()
  const { initialising, profile } = useAuth()
  const path = useRoute()

  if (initialising) return <Splash />
  if (!profile) return <LoginScreen theme={theme} onToggleTheme={toggleTheme} />

  if (path.startsWith('/admin')) {
    return profile.role === 'admin'
      ? <AdminPanel onExit={() => navigate('/')} />
      : <NotAllowed onExit={() => navigate('/')} />
  }

  return <ChatApp theme={theme} onToggleTheme={toggleTheme} />
}

function Splash() {
  return (
    <div className="flex h-full items-center justify-center bg-surface">
      <Logo size={40} />
    </div>
  )
}

function NotAllowed({ onExit }: { onExit: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-surface p-4">
      <Logo size={48} />
      <h1 className="text-xl font-semibold text-ink">Access denied</h1>
      <p className="text-sm text-ink-2">You do not have administrator access.</p>
      <button
        onClick={onExit}
        className="flex items-center gap-1.5 rounded-full border border-line px-4 py-2 text-sm text-ink hover:bg-surface-2"
      >
        <ArrowLeft size={16} />
        Back to chat
      </button>
    </div>
  )
}
