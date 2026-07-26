"use client";

import { useState } from "react";
import {
  Copy,
  Check,
  FileText,
} from "lucide-react";
import { renderMarkdown } from "@/lib/markdown";
import { getFileUrl } from "@/lib/api";
import type { ChatMessage as ChatMessageType } from "@/lib/api";

interface MessageProps {
  message: ChatMessageType;
  isStreaming?: boolean;
  isFirst?: boolean;
}

export function Message({ message, isStreaming, isFirst }: MessageProps) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Attachments preview (shown for user messages that are filtered out)
  const hasAttachments =
    message.attachments && message.attachments.length > 0;

  // User messages not rendered as chat bubbles — text goes to header pill
  if (isUser) {
    // Only show attachments if any, no message bubble
    if (!hasAttachments) return null;
    return (
      <div className="px-4 message-enter">
        <div className="flex flex-wrap gap-2 mb-4">
          {message.attachments?.map((att) => (
            <AttachmentChip key={att.id} att={att} />
          ))}
        </div>
      </div>
    );
  }

  // Assistant
  const isEmpty = !message.content && isStreaming;
  const html = renderMarkdown(message.content || "", !!isStreaming);

  return (
    <div className="px-4 message-enter">
      <div className="mx-auto max-w-chat">
        {/* "Fast answer" section label for first assistant response */}
        {isFirst && (
          <div className="flex items-center gap-2 mb-4">
            <div className="h-5 w-5 rounded-full bg-[var(--accent-primary)]/10 flex items-center justify-center">
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--accent-primary)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
              Fast answer
            </span>
          </div>
        )}

        {/* Content */}
        <div className="min-w-0">
          {isEmpty ? (
            <div className="typing-indicator">
              <span />
              <span />
              <span />
            </div>
          ) : (
            <div
              className="text-[15px] leading-relaxed text-[var(--text-primary)] [&_p]:my-1.5 [&_p]:leading-relaxed"
              dangerouslySetInnerHTML={{ __html: html }}
              onClick={handleCodeCopy}
            />
          )}
        </div>

        {/* Hover copy action */}
        {!isStreaming && message.content && (
          <div className="mt-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={handleCopy}
              title="Copy"
              className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AttachmentChip({ att }: { att: any }) {
  if (att.kind === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={getFileUrl(att.r2Key)}
        alt={att.name}
        className="h-20 w-20 rounded-lg object-cover border border-[var(--border-subtle)]"
      />
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2">
      <FileText className="h-4 w-4 text-[var(--accent-primary)]" />
      <div className="min-w-0">
        <div className="max-w-[140px] truncate text-xs font-medium text-[var(--text-primary)]">
          {att.name}
        </div>
        <div className="text-[10px] text-[var(--text-muted)]">
          {att.kind.toUpperCase()}
        </div>
      </div>
    </div>
  );
}

// Handle copy button clicks inside code blocks
function handleCodeCopy(e: React.MouseEvent) {
  const target = e.target as HTMLElement;
  const btn = target.closest(".code-copy-btn") as HTMLElement | null;
  if (!btn) return;
  const code = decodeURIComponent(btn.dataset.code || "");
  navigator.clipboard.writeText(code);
  const original = btn.innerHTML;
  btn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied';
  setTimeout(() => {
    btn.innerHTML = original;
  }, 1500);
}
