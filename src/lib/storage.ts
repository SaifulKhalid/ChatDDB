import type { Conversation } from '../types'

const CONVERSATIONS_KEY = 'chatddb.conversations'
export const THEME_KEY = 'chatddb.theme'

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(CONVERSATIONS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as Conversation[]
  } catch {
    return []
  }
}

export function saveConversations(conversations: Conversation[]): void {
  try {
    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations))
  } catch {
    // Storage full or unavailable — keep the app usable in memory
  }
}

/**
 * Marks the pre-Phase-2 local history as imported.
 *
 * A flag rather than deleting the blob: the import inserts in chunks, so a
 * failure part-way leaves some conversations on the server and some not. Keeping
 * the original means that is recoverable by hand instead of being data loss.
 */
const IMPORTED_KEY = 'chatddb.importedAt'

export function localHistoryImported(): boolean {
  try {
    return localStorage.getItem(IMPORTED_KEY) !== null
  } catch {
    return true
  }
}

export function markLocalHistoryImported(): void {
  try {
    localStorage.setItem(IMPORTED_KEY, String(Date.now()))
  } catch {
    /* ignore */
  }
}

export type Theme = 'light' | 'dark'

export function loadTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY)
    if (t === 'light' || t === 'dark') return t
  } catch {
    /* ignore */
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    /* ignore */
  }
}
