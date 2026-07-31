import { useEffect, useState } from 'react'
import { loadTheme, saveTheme } from './storage'
import type { Theme } from './storage'

/**
 * Light/dark mode.
 *
 * Extracted from `App.tsx` when the login gate arrived: the theme has to apply
 * to the login screen too, which renders instead of the chat UI rather than
 * inside it. One hook, used by the gate, keeps a single owner of the `dark`
 * class on `<html>`.
 */
export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(loadTheme)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    saveTheme(theme)
  }, [theme])

  return {
    theme,
    toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
  }
}

export type { Theme }
