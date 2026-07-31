import { useEffect, useState } from 'react'

/**
 * Returns the current pathname, updated on popstate and custom navigate events.
 */
export function useRoute(): string {
  const [path, setPath] = useState(() => window.location.pathname)

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    window.addEventListener('chatddb:navigate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('chatddb:navigate', onPop)
    }
  }, [])

  return path
}

/**
 * Navigates to a new path without a full page reload.
 *
 * Dispatches a custom event so `useRoute` listeners pick up the change.
 */
export function navigate(to: string) {
  if (window.location.pathname === to) return
  window.history.pushState({}, '', to)
  window.dispatchEvent(new Event('chatddb:navigate'))
}
