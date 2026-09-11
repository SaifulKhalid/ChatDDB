import { useEffect, useRef, useState } from 'react'

/**
 * The placeholder shown while an assistant message exists but has no content yet.
 *
 * It replaces a bare pulsing dot, which said only "something is happening" — and
 * said it identically whether the first token was 300ms away or the model had
 * just called `generate_image` and the round trip was about to take fifteen
 * seconds. `routes/chat.ts` resolves an image tool call *before* `toClientStream`
 * opens the SSE response, so `message.content` is empty for that whole window;
 * this branch is the only thing on screen for it. A word that keeps changing is
 * the cheapest available signal that the wait is alive rather than wedged.
 *
 * Self-contained on purpose: the caller decides *whether* a response is pending,
 * not how the waiting is drawn, so the interval lives here and nothing has to be
 * threaded down for it.
 */

/**
 * Deliberately mixed generic and coursework-flavoured.
 *
 * A list of pure synonyms for "loading" reads as a spinner with extra steps.
 * Words like "Deriving" and "Checking the numbers" are the ones that make it
 * read like the tool is doing the reader's kind of work — and they are honest,
 * since that is usually what was asked. Kept under ~20 characters each: this
 * sits inline at message height, so a long phrase reflows the line.
 */
const WORDS = [
  'Thinking',
  'Working it out',
  'Computing',
  'Deriving',
  'Checking the numbers',
  'Sketching it out',
  'Doodling',
] as const

/**
 * Jitter range for the advance, re-rolled per tick rather than fixed per mount.
 *
 * Two messages can be pending at once (a regenerate over a still-streaming turn,
 * or a reopened tab), and two `setInterval`s started at a round number stay in
 * visible lock-step for as long as both live — which reads as one animation
 * driving both, not two independent responses. Re-rolling each tick means they
 * drift apart within a few words however close together they mounted.
 */
const MIN_MS = 1600
const MAX_MS = 2200

export function ThinkingIndicator({ words = WORDS }: { words?: readonly string[] }) {
  const [index, setIndex] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Depends on `words.length`, not `words`: an inline array literal from a caller
  // would be a new identity every render and restart the cycle on each one.
  useEffect(() => {
    const schedule = () => {
      timer.current = setTimeout(
        () => {
          setIndex((i) => (i + 1) % words.length)
          schedule()
        },
        MIN_MS + Math.random() * (MAX_MS - MIN_MS),
      )
    }
    schedule()
    return () => clearTimeout(timer.current)
  }, [words.length])

  const word = words[index % words.length] ?? words[0]

  return (
    // `h-7` matches the line box of the first rendered paragraph, so the
    // transcript does not shift when the first token replaces this.
    <div className="flex h-7 items-center gap-2 text-sm text-ink-2">
      {/*
        The rotating word is hidden from assistive tech and the static text below
        is what gets read. A live region here would announce a new word every two
        seconds for the length of the generation; the fact worth conveying is
        "a response is being generated", and that fact does not change until the
        response arrives.
      */}
      <span aria-hidden="true" className="inline-block size-2 animate-pulse rounded-full bg-ink-2" />
      {/* Keyed so React remounts the span and the fade-in runs from the start;
          a plain text swap at this size reads as a glitch rather than a change. */}
      <span key={word} aria-hidden="true" className="thinking-word">
        {word}…
      </span>
      <span className="sr-only">Generating response</span>
    </div>
  )
}
