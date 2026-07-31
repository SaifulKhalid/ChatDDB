export type Role = 'user' | 'assistant'

export interface Message {
  id: string
  role: Role
  content: string
  createdAt: number
  /** True while tokens are still arriving for this message */
  streaming?: boolean
  /** Set when generation failed or was stopped before any content arrived */
  error?: string
  /** Attached files (images / PDFs), populated from transcript or after send */
  attachments?: import('./lib/apiTypes').PublicFile[]
}

export interface Conversation {
  id: string
  title: string
  /**
   * Where `title` came from. Drives the post-turn refresh: only a `placeholder`
   * is worth re-reading, and a `manual` title is never replaced.
   */
  titleSource: import('./lib/apiTypes').TitleSource
  messages: Message[]
  createdAt: number
  updatedAt: number
}

export function newId(): string {
  return crypto.randomUUID()
}
