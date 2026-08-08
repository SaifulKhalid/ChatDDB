import { useRef, type KeyboardEvent } from 'react'
import type { ModelSpec } from '../lib/apiTypes'

interface ModelPickerProps {
  /** The registry, verbatim from `GET /api/me`. One segment per entry. */
  models: ModelSpec[]
  /** `null` is Auto: send no `model` field and let the server resolve one. */
  value: string | null
  onChange: (modelId: string | null) => void
  disabled?: boolean
  /** Why the picker is inert, when it is. Shown as the tooltip on every segment. */
  disabledReason?: string
}

interface Option {
  /** `null` for Auto. Doubles as the value passed back to `onChange`. */
  id: string | null
  short: string
  title: string
  note?: string
}

/**
 * Auto / ChatGPT / Claude, as a segmented control above the composer.
 *
 * Auto is a real choice rather than a synonym for the default entry, and the
 * difference is failover: only an Auto turn may cross over to the backup
 * gateway. An explicit pick is answered by its own vendor or it fails — see
 * `chainFor` in `worker/failover.ts`. The tooltips say so, because a user who
 * picks Claude to compare two models deserves to know which of them answered.
 *
 * Segments come from the registry, so a third model is an entry in
 * `worker/models.ts` and no edit here.
 */
export function ModelPicker({
  models,
  value,
  onChange,
  disabled,
  disabledReason,
}: ModelPickerProps) {
  const groupRef = useRef<HTMLDivElement>(null)

  // The registry's `default: true` entry. The Worker resolves Auto from
  // `AGENTROUTER_MODEL` instead, which is the same model in every deployment so
  // far; if the two ever disagree, this label is the one that is wrong.
  const fallbackTo = models.find((m) => m.default) ?? models[0]

  const options: Option[] = [
    {
      id: null,
      short: 'Auto',
      title: fallbackTo
        ? `Auto — ${fallbackTo.short}, and quietly retries elsewhere if that gateway fails.`
        : 'Auto — let the server choose.',
    },
    ...models.map((m) => ({
      id: m.id,
      short: m.short,
      // No mention of a backup: there is deliberately none for an explicit pick.
      title: [`Always ${m.label}.`, m.note].filter(Boolean).join(' '),
      note: m.note,
    })),
  ]

  const selected = options.find((o) => o.id === value) ?? options[0]

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return
    const at = options.indexOf(selected)
    const last = options.length - 1
    let next: number
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = at === last ? 0 : at + 1
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = at === 0 ? last : at - 1
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = last
        break
      default:
        return
    }
    e.preventDefault()
    onChange(options[next].id)
    // Roving tabindex: the group is one tab stop, so moving the selection has to
    // move focus with it or the arrow keys read as doing nothing.
    groupRef.current?.querySelectorAll('button')[next]?.focus()
  }

  if (models.length === 0) return null

  return (
    <div className="mb-2 flex items-center gap-2 px-1">
      <div
        ref={groupRef}
        role="radiogroup"
        aria-label="Model"
        onKeyDown={onKeyDown}
        className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-line bg-surface-2 p-0.5"
      >
        {options.map((opt) => {
          const on = opt === selected
          return (
            <button
              key={opt.id ?? 'auto'}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(opt.id)}
              title={disabled ? (disabledReason ?? opt.title) : opt.title}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
                on
                  ? 'bg-accent text-surface'
                  : 'text-ink-2 hover:bg-surface-3 hover:text-ink disabled:hover:bg-transparent'
              }`}
            >
              {opt.short}
            </button>
          )
        })}
      </div>

      {/* A capability worth knowing before sending, not after. `title` carries it
          on touch, where there is no room for the text and no hover to reveal it. */}
      {selected.note && (
        <span className="truncate text-xs text-ink-2" title={selected.note}>
          {selected.note}
        </span>
      )}
    </div>
  )
}
