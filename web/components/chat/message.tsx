"use client";

import { useState } from "react";
import {
  Copy,
  Check,
  RefreshCw,
  ThumbsUp,
  ThumbsDown,
  Pencil,
  FileText,
} from "lucide-react";
import { Logo } from "@/components/ui/logo";
import { renderMarkdown } from "@/lib/markdown";
import { getFileUrl } from "@/lib/api";
import type { ChatMessage as ChatMessageType } from "@/lib/api";

interface MessageProps {
  message: ChatMessageType;
  isStreaming?: boolean;
}

export function Message({ message, isStreaming }: MessageProps) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (isUser) {
    return (
      <div className="group flex justify-end px-4 message-enter">
        <div className="flex max-w-[85%] flex-col items-end gap-1">
          {/* Attachments */}
          {message.attachments?.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2 mb-1">
              {message.attachments.map((att) => (
                <AttachmentChip key={att.id} att={att} />
              ))}
            </div>
          )}
          <div className="rounded-3xl rounded-br-md bg-[var(--bg-card)] px-4 py-2.5 text-[15px] leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap break-words">
            {message.content}
          </div>
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={handleCopy}
              className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              title="Copy"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              title="Edit"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Assistant
  const isEmpty = !message.content && isStreaming;
  const html = renderMarkdown(message.content || "", !!isStreaming);

  return (
    <div className="group flex gap-3 px-4 message-enter">
      <Logo size={28} className="mt-1 shrink-0" />
      <div className="min-w-0 flex-1">
        {isEmpty ? (
          <div className="typing-indicator">
            <span />
            <span />
            <span />
          </div>
        ) : (
          <div
            className="prose-chat max-w-none text-[15px] leading-relaxed text-[var(--text-primary)]"
            dangerouslySetInnerHTML={{ __html: html }}
            onClick={handleCodeCopy}
          />
        )}

        {/* Hover actions */}
        {!isStreaming && message.content && (
          <div className="mt-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <ActionButton onClick={handleCopy} title="Copy">
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </ActionButton>
            <ActionButton title="Regenerate">
              <RefreshCw className="h-3.5 w-3.5" />
            </ActionButton>
            <ActionButton title="Like">
              <ThumbsUp className="h-3.5 w-3.5" />
            </ActionButton>
            <ActionButton title="Dislike">
              <ThumbsDown className="h-3.5 w-3.5" />
            </ActionButton>
          </div>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="rounded p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
    >
      {children}
    </button>
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