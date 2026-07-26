/**
 * Minimal Markdown renderer for ChatDDB.
 * Converts markdown text to safe HTML with code block enhancements.
 */

export function renderMarkdown(text: string, isStreaming = false): string {
  if (!text) return "";

  // Escape HTML
  let html = escapeHtml(text);

  // Code blocks with language labels (must come before inline code)
  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_m: string, lang: string, code: string) => {
      const langLabel = lang || "code";
      const escapedCode = escapeHtml(code.trim());
      const encoded = encodeURIComponent(code.trim());
      return [
        '<div class="code-block-wrapper my-3 rounded-xl overflow-hidden border border-[var(--border-subtle)] bg-[var(--bg-primary)]">',
        '<div class="code-block-header flex items-center justify-between px-4 py-2 bg-[var(--bg-card)] border-b border-[var(--border-subtle)]">',
        `<span class="text-xs font-medium text-[var(--text-muted)]">${escapeHtml(langLabel)}</span>`,
        `<button class="code-copy-btn flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-all" data-code="${encoded}">`,
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
        "Copy",
        "</button>",
        "</div>",
        `<pre class="overflow-x-auto p-4 text-sm leading-relaxed"><code class="font-mono text-[var(--text-primary)]">${escapedCode}</code></pre>`,
        "</div>",
      ].join("");
    }
  );

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code class='px-1.5 py-0.5 rounded-md bg-[var(--bg-card)] border border-[var(--border-subtle)] text-sm font-mono text-[var(--accent-primary)]'>$1</code>");

  // Headers
  html = html.replace(/^### (.+)$/gm, "<h3 class='text-base font-semibold mt-4 mb-2'>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2 class='text-lg font-semibold mt-5 mb-2'>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1 class='text-xl font-semibold mt-6 mb-3'>$1</h1>");

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong class='font-semibold'>$1</strong>");
  // Italic
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  // Links
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-[var(--accent-primary)] hover:underline">$1</a>'
  );

  // Lists
  html = html.replace(/^\s*[-*] (.+)$/gm, "<li class='ml-4 text-sm'>$1</li>");
  html = html.replace(/(<li[\s\S]*?<\/li>)/g, "<ul class='space-y-1 my-2'>$1</ul>");
  html = html.replace(/<\/ul>\s*<ul>/g, "");

  // Numbered lists
  html = html.replace(/^\s*\d+\. (.+)$/gm, "<li class='ml-4 text-sm list-decimal'>$1</li>");

  // Horizontal rules
  html = html.replace(/^---$/gm, "<hr class='my-4 border-[var(--border-subtle)]' />");

  // Blockquotes
  html = html.replace(
    /^> (.+)$/gm,
    "<blockquote class='border-l-2 border-[var(--accent-primary)] pl-4 italic text-[var(--text-secondary)] my-2'>$1</blockquote>"
  );

  // Paragraphs
  html = html.replace(/\n\n/g, "</p><p class='my-2 leading-relaxed'>");
  html = html.replace(/\n/g, "<br />");

  // Wrap in paragraph if not starting with a block element
  if (
    !html.match(
      /^<(h[1-6]|pre|div|ul|ol|li|blockquote|hr|p)/i
    )
  ) {
    html = "<p class='my-1 leading-relaxed'>" + html + "</p>";
  }

  // Streaming cursor at the end
  if (isStreaming) {
    html = '<div class="streaming-active">' + html + '<span class="cursor-blink inline-block"></span></div>';
  }

  return html;
}

function escapeHtml(str: string): string {
  if (typeof document !== "undefined") {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
  // Server-side fallback
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
