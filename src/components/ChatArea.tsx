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

// Kept at four so the sm:grid-cols-2 grid stays a clean 2x2 with no orphan tile.
// The picture entry replaced "Summarize text" (the weakest of the four — it
// overlapped "Explain a concept") because implicit image generation is the one
// capability users don't believe exists: the model calls generate_image off a
// plain description, but nothing in the UI said so, so people hunted for a
// button or gave up. The prompt deliberately contains no "generate"/"draw" verb
// — the tile only teaches its lesson if the example is ordinary language.
const SUGGESTIONS = [
  { title: 'Explain a concept', prompt: 'Explain how databases index data, in simple terms.' },
  { title: 'Write some code', prompt: 'Write a TypeScript function that debounces another function.' },
  { title: 'Brainstorm ideas', prompt: 'Brainstorm five names for a weekend coding project.' },
  { title: 'Describe a picture', prompt: 'A fluffy orange cat asleep on a sunny windowsill.' },
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

  // Follow the stream while the user is at the bottom — rAF to avoid jank
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !pinnedToBottom) return
    let raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [lastContent, messages.length, conversation?.id, pinnedToBottom])

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    setPinnedToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120)
  }

  if (!conversation || messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo size={48} />
          <h1 className="text-[1.7rem] font-semibold tracking-tight md:text-[1.9rem]">
            How can I help you today?
          </h1>
          <p className="max-w-md text-sm text-ink-2">Ask anything — code, math, diagrams, or describe a picture and watch it appear.</p>
        </div>
        <div className="grid w-full max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.title}
              onClick={() => onSuggestion(s.prompt)}
              className="rounded-2xl border border-line bg-surface px-4 py-3.5 text-left shadow-sm transition-colors hover:bg-surface-2 hover:border-ink-2/20"
            >
              <span className="block text-sm font-medium">{s.title}</span>
              <span className="mt-1 block truncate text-xs leading-relaxed text-ink-2">
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
