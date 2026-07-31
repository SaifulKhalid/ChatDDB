import { useEffect, useRef, useState } from 'react'
import {
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import type { Conversation } from '../types'
import { Logo } from './Logo'

interface SidebarProps {
  conversations: Conversation[]
  activeId: string | null
  open: boolean
  /** True while the first `GET /api/sessions` is in flight. */
  loading?: boolean
  onClose: () => void
  onNewChat: () => void
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}

interface Section {
  label: string
  items: Conversation[]
}

function groupByDate(conversations: Conversation[]): Section[] {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000
  const sections: Section[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Previous 30 days', items: [] },
    { label: 'Older', items: [] },
  ]
  for (const c of conversations) {
    const t = c.updatedAt
    if (t >= startOfToday) sections[0].items.push(c)
    else if (t >= startOfToday - day) sections[1].items.push(c)
    else if (t >= startOfToday - 7 * day) sections[2].items.push(c)
    else if (t >= startOfToday - 30 * day) sections[3].items.push(c)
    else sections[4].items.push(c)
  }
  return sections.filter((s) => s.items.length > 0)
}

export function Sidebar({
  conversations,
  activeId,
  open,
  loading,
  onClose,
  onNewChat,
  onSelect,
  onRename,
  onDelete,
}: SidebarProps) {
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId) editInputRef.current?.focus()
  }, [editingId])

  const filtered = query.trim()
    ? conversations.filter((c) =>
        c.title.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : conversations

  const sections = groupByDate(filtered)

  function commitRename() {
    if (editingId && draftTitle.trim()) onRename(editingId, draftTitle.trim())
    setEditingId(null)
  }

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[260px] flex-col bg-surface-2 transition-transform duration-200 ease-in-out md:static md:transition-none ${
          open ? 'translate-x-0' : '-translate-x-full md:hidden'
        }`}
        aria-label="Chat history"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 pt-3 pb-1">
          <div className="flex items-center gap-2 px-1">
            <Logo size={26} />
            <span className="text-sm font-semibold">ChatDDB</span>
          </div>
          <button
            className="rounded-lg p-2 text-ink-2 hover:bg-surface-3 md:hidden"
            onClick={onClose}
            aria-label="Close sidebar"
          >
            <X size={18} />
          </button>
        </div>

        {/* New chat */}
        <div className="px-3 pt-2">
          <button
            onClick={onNewChat}
            className="flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-surface-3"
          >
            <Plus size={16} />
            New chat
          </button>
        </div>

        {/* Search */}
        <div className="px-3 pt-2">
          <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-ink-2 focus-within:bg-surface-3 hover:bg-surface-3">
            <Search size={15} className="shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats"
              className="w-full bg-transparent text-ink outline-none placeholder:text-ink-2"
            />
          </div>
        </div>

        {/* Conversation list */}
        <nav className="mt-2 flex-1 overflow-y-auto px-3 pb-3">
          {sections.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-ink-2">
              {/* "No chats yet" during the first fetch reads as data loss. */}
              {loading
                ? 'Loading your chats…'
                : query
                  ? 'No chats match your search.'
                  : 'No chats yet. Start a new one!'}
            </p>
          )}
          {sections.map((section) => (
            <div key={section.label} className="mb-2">
              <h3 className="px-2 py-2 text-xs font-semibold text-ink-2">
                {section.label}
              </h3>
              <ul>
                {section.items.map((c) => (
                  <li key={c.id} className="group relative">
                    {editingId === c.id ? (
                      <input
                        ref={editInputRef}
                        value={draftTitle}
                        onChange={(e) => setDraftTitle(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename()
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                        className="w-full rounded-lg border border-accent bg-surface px-2 py-1.5 text-sm outline-none"
                      />
                    ) : (
                      <button
                        onClick={() => onSelect(c.id)}
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm ${
                          c.id === activeId
                            ? 'bg-surface-3'
                            : 'hover:bg-surface-3'
                        }`}
                      >
                        <MessageSquare size={15} className="shrink-0 text-ink-2" />
                        <span className="flex-1 truncate pr-10">{c.title}</span>
                      </button>
                    )}
                    {editingId !== c.id && (
                      <div
                        className={`absolute inset-y-0 right-1 hidden items-center gap-0.5 group-hover:flex ${
                          c.id === activeId ? 'flex' : ''
                        }`}
                      >
                        <button
                          onClick={() => {
                            setEditingId(c.id)
                            setDraftTitle(c.title)
                          }}
                          className="rounded p-1.5 text-ink-2 hover:bg-surface hover:text-ink"
                          aria-label={`Rename "${c.title}"`}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => onDelete(c.id)}
                          className="rounded p-1.5 text-ink-2 hover:bg-surface hover:text-red-500"
                          aria-label={`Delete "${c.title}"`}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-line px-4 py-3">
          <p className="text-xs text-ink-2">
            ChatDDB by <a href="https://labddb.com" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">LabDDB</a>
          </p>
        </div>
      </aside>
    </>
  )
}
