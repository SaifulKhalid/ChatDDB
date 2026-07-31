import { useEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { Conversation } from '../types'
import { MessageItem } from './MessageItem'
import { Logo } from './Logo'

interface ChatAreaProps {
  conversation: Conversation | null
  streaming: boolean
  onRegenerate: () => void
  onEditMessage: (id: string, content: string) => void
  onSuggestion: (text: string) => void
}

const SUGGESTIONS = [
  { title: 'Explain a concept', prompt: 'Explain how databases index data, in simple terms.' },
  { title: 'Write some code', prompt: 'Write a TypeScript function that debounces another function.' },
  { title: 'Brainstorm ideas', prompt: 'Brainstorm five names for a weekend coding project.' },
  { title: 'Summarize text', prompt: 'Summarize the key ideas of the CAP theorem in three bullets.' },
]

export function ChatArea({
  conversation,
  streaming,
  onRegenerate,
  onEditMessage,
  onSuggestion,
}: ChatAreaProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pinnedToBottom, setPinnedToBottom] = useState(true)
  const messages = conversation?.messages ?? []
  const lastContent = messages.length ? messages[messages.length - 1].content : ''

  // Follow the stream while the user is at the bottom
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedToBottom) el.scrollTop = el.scrollHeight
  }, [lastContent, messages.length, conversation?.id, pinnedToBottom])

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    setPinnedToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60)
  }

  if (!conversation || messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4">
        <div className="flex flex-col items-center gap-3">
          <Logo size={44} />
          <h1 className="text-2xl font-semibold md:text-3xl">
            How can I help you today?
          </h1>
        </div>
        <div className="grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.title}
              onClick={() => onSuggestion(s.prompt)}
              className="rounded-2xl border border-line px-4 py-3 text-left hover:bg-surface-2"
            >
              <span className="block text-sm font-medium">{s.title}</span>
              <span className="mt-0.5 block truncate text-xs text-ink-2">
                {s.prompt}
              </span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-3 py-6 md:px-4">
          {messages.map((m, i) => (
            <MessageItem
              key={m.id}
              message={m}
              isLast={i === messages.length - 1 && m.role === 'assistant'}
              busy={streaming}
              onRegenerate={streaming ? undefined : onRegenerate}
              onEdit={onEditMessage}
            />
          ))}
        </div>
      </div>
      {!pinnedToBottom && (
        <button
          onClick={() => {
            const el = scrollRef.current
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
            setPinnedToBottom(true)
          }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-line bg-surface p-2 shadow-md hover:bg-surface-2"
          aria-label="Scroll to bottom"
        >
          <ArrowDown size={16} />
        </button>
      )}
    </div>
  )
}
