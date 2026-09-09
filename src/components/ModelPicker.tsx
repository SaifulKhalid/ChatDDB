import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, Sparkles } from 'lucide-react'
import type { ModelSpec } from '../lib/apiTypes'

interface ModelPickerProps {
  models: ModelSpec[]
  value: string | null
  onChange: (modelId: string | null) => void
  disabled?: boolean
  disabledReason?: string
}

interface Option {
  id: string | null
  short: string
  title: string
}

export function ModelPicker({ models, value, onChange, disabled, disabledReason }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const options: Option[] = [
    {
      id: null,
      short: 'Auto',
      title: 'Picks the best AI for your message.',
    },
    ...models.map((m) => ({
      id: m.id,
      short: m.short,
      title: `Always ${m.label}.`,
    })),
  ]

  const selected = options.find((o) => o.id === value) ?? options[0]
  const isAuto = selected.id === null

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey as unknown as EventListener)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey as unknown as EventListener)
    }
  }, [open])

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (disabled) return
    if (!open && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) {
      e.preventDefault()
      setOpen(true)
      return
    }
    if (!open) return
    const at = options.indexOf(selected)
    const last = options.length - 1
    let next: number | null = null
    switch (e.key) {
      case 'ArrowDown':
        next = at === last ? 0 : at + 1
        break
      case 'ArrowUp':
        next = at === 0 ? last : at - 1
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = last
        break
      case 'Enter':
      case ' ':
        setOpen(false)
        return
      case 'Escape':
        setOpen(false)
        return
      default:
        return
    }
    e.preventDefault()
    if (next !== null) {
      onChange(options[next].id)
      const n = next
      requestAnimationFrame(() => {
        listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-opt]')[n]?.focus()
      })
    }
  }

  if (models.length === 0) return null

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={disabled ? (disabledReason ?? selected.title) : selected.title}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 shrink-0 ${
          isAuto
            ? 'border-accent/30 bg-accent/10 text-accent hover:bg-accent/15'
            : 'border-line bg-surface text-ink hover:bg-surface-3'
        }`}
      >
        {isAuto && <Sparkles size={11} className="shrink-0" />}
        <span className="max-w-[90px] truncate sm:max-w-none">{selected.short}</span>
        <ChevronDown
          size={11}
          className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label="AI Service"
          onKeyDown={onKeyDown}
          className="absolute bottom-full right-0 z-30 mb-2 w-max min-w-[220px] max-w-[calc(100vw-32px)] rounded-xl border border-line bg-surface py-1 shadow-xl"
        >
          {options.map((opt) => {
            const on = opt === selected
            return (
              <button
                key={opt.id ?? 'auto'}
                type="button"
                data-opt
                role="option"
                aria-selected={on}
                disabled={disabled}
                onClick={() => {
                  onChange(opt.id)
                  setOpen(false)
                }}
                title={disabled ? (disabledReason ?? opt.title) : opt.title}
                className={`flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors disabled:opacity-40 ${
                  on ? 'bg-accent/10 text-accent' : 'hover:bg-surface-2'
                }`}
              >
                <span
                  className={`mt-0.5 size-3 shrink-0 rounded-full border-2 ${
                    on ? 'border-accent bg-accent' : 'border-line'
                  }`}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className={`block text-xs font-semibold ${on ? 'text-accent' : 'text-ink'}`}>
                    {opt.short}
                  </span>
                  <span className="block text-[11px] leading-snug text-ink-2">
                    {opt.title}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
