import { Component, type ReactNode } from 'react'

interface MarkdownErrorBoundaryProps {
  children: ReactNode
  /** Renders instead of `children` once the tree has thrown. */
  fallback: ReactNode
  /**
   * Changing this clears a previous failure. Pass the message content: a tree
   * that threw on a half-written construct gets another chance as soon as more
   * text streams in, rather than being stuck on the fallback for good.
   */
  resetKey: string
}

interface MarkdownErrorBoundaryState {
  failed: boolean
  /** The `resetKey` the current `failed` verdict was reached under. */
  seenKey: string | null
}

/**
 * Guards the markdown render so one bad construct degrades to plain text
 * instead of blanking the conversation.
 *
 * `rehype-katex` is configured with `throwOnError: false` and emits an error
 * span rather than throwing, so this is insurance against the rest of the
 * pipeline — not the expected path for malformed LaTeX.
 */
export class MarkdownErrorBoundary extends Component<
  MarkdownErrorBoundaryProps,
  MarkdownErrorBoundaryState
> {
  state: MarkdownErrorBoundaryState = { failed: false, seenKey: null }

  static getDerivedStateFromError(): Pick<MarkdownErrorBoundaryState, 'failed'> {
    return { failed: true }
  }

  /**
   * Clears a failure as soon as the content changes.
   *
   * Not a `key` on the parent: `resetKey` is the message content, so keying
   * would tear down and rebuild the whole markdown tree on every streamed
   * token. Deriving it here is a single render pass either way — the error
   * re-render runs this too, but props and `seenKey` still match at that point,
   * so `failed` survives long enough to show the fallback.
   */
  static getDerivedStateFromProps(
    props: MarkdownErrorBoundaryProps,
    state: MarkdownErrorBoundaryState,
  ): Partial<MarkdownErrorBoundaryState> | null {
    if (props.resetKey === state.seenKey) return null
    return { failed: false, seenKey: props.resetKey }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
