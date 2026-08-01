import { createContext, useContext } from 'react'

/**
 * Whether the message currently being rendered is still arriving.
 *
 * Markdown components are handed to `ReactMarkdown` as a static map, so a child
 * renderer has no props route back to the message it belongs to. `SvgFigure`
 * needs exactly one bit of that context: an `<svg>` with no closing tag means
 * "still drawing" during a stream and "this figure never finished" after one,
 * and those want opposite treatments — a spinner versus the source.
 *
 * Deliberately a single boolean rather than the message object. Passing the
 * message down would make every code block re-render on every token.
 */
export const StreamingContext = createContext(false)

export function useStreaming(): boolean {
  return useContext(StreamingContext)
}
