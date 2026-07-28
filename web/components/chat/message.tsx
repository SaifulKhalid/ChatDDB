"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Copy,
  Check,
  FileText,
  Sparkles,
  Download,
  RefreshCw,
} from "lucide-react";
import { renderMarkdown } from "@/lib/markdown";
import { getFileUrl } from "@/lib/api";
import { useChatStore } from "@/stores/chat-store";
import { getProviderEmoji } from "@/lib/constants";
import type { ChatMessage as ChatMessageType } from "@/lib/api";

interface MessageProps {
  message: ChatMessageType;
  isStreaming?: boolean;
  isFirst?: boolean;
}

const THINKING_PHRASES = [
  "Thinking…",
  "Brainstorming…",
  "DDBing…",
  "Analyzing…",
  "Processing…",
  "Computing…",
];

export function Message({ message, isStreaming, isFirst }: MessageProps) {
  const [copied, setCopied] = useState(false);
  const [thinkingIndex, setThinkingIndex] = useState(0);
  const isUser = message.role === "user";

  // Rotate thinking phrases while streaming with no content
  const isEmpty = !message.content && isStreaming;
  useEffect(() => {
    if (!isEmpty) {
      setThinkingIndex(0);
      return;
    }
    const interval = setInterval(() => {
      setThinkingIndex((prev) => (prev + 1) % THINKING_PHRASES.length);
    }, 2000);
    return () => clearInterval(interval);
  }, [isEmpty]);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Attachments preview (shown for user messages that are filtered out)
  const hasAttachments =
    message.attachments && message.attachments.length > 0;

  // User messages — right-aligned with bubble background
  if (isUser) {
    return (
      <div className="px-4 message-enter">
        <div className="mx-auto max-w-chat">
          <div className="flex flex-col items-end">
            {/* Attachments preview */}
            {hasAttachments && (
              <div className="flex flex-wrap gap-2 mb-3 justify-end">
                {message.attachments?.map((att) => (
                  <AttachmentChip key={att.id} att={att} />
                ))}
              </div>
            )}
            {/* Message text bubble */}
            {message.content && (
              <div
                className="inline-block max-w-[80%] rounded-2xl px-4 py-2.5
                  bg-[var(--accent-primary)]/10
                  text-[15px] lg:text-[18.75px] leading-relaxed text-[var(--text-primary)]"
              >
                {message.content}
              </div>
            )}
            {!message.content && !hasAttachments && (
              <div className="text-sm text-[var(--text-muted)] italic">(empty message)</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Assistant
  const html = renderMarkdown(message.content || "", !!isStreaming);

  // Parse image URLs for download/try-again buttons
  const isImageGenMessage = message.content.startsWith("🎨");
  const imageUrls = isImageGenMessage
    ? extractImageUrls(message.content)
    : [];

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
            <div className="flex items-center gap-3 py-3">
              {/* Animated dots */}
              <div className="typing-indicator">
                <span />
                <span />
                <span />
              </div>
              {/* Rotating thinking phrase */}
              <div className="relative h-5 overflow-hidden">
                <span
                  key={thinkingIndex}
                  className="absolute inset-0 flex items-center text-sm text-[var(--text-muted)] animate-fade-in"
                >
                  {THINKING_PHRASES[thinkingIndex]}
                </span>
              </div>
            </div>
          ) : (
            <div
              className="text-[15px] lg:text-[18.75px] leading-relaxed text-[var(--text-primary)] [&_p]:my-1.5 [&_p]:leading-relaxed"
              dangerouslySetInnerHTML={{ __html: html }}
              onClick={handleCodeCopy}
            />
          )}
        </div>

        {/* "Why this model?" badge — shown for auto-selected assistant messages */}
        <ModelSelectionBadge message={message} isStreaming={isStreaming} />

        {/* Image action buttons: download + try again */}
        {!isStreaming && isImageGenMessage && imageUrls.length > 0 && (
          <ImageActions
            imageUrls={imageUrls}
            message={message}
          />
        )}

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

/** Badge that explains why Auto mode selected a particular model. */
function ModelSelectionBadge({ message, isStreaming }: { message: ChatMessageType; isStreaming?: boolean }) {
  const currentModelId = useChatStore((s) => s.currentModelId);
  const selectionInfo = message.selectionInfo;

  // Only show in auto mode, when per-message selection info exists, and when not streaming
  if (
    currentModelId !== "auto" ||
    !selectionInfo ||
    isStreaming
  )
    return null;

  // Derive provider from model ID for emoji
  const provider = selectionInfo.modelId.includes(":")
    ? selectionInfo.modelId.split(":")[0]
    : "";

  return (
    <div className="mt-3 flex items-start gap-2 px-1">
      <Sparkles className="h-3.5 w-3.5 text-[var(--accent-primary)] mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="text-xs font-medium text-[var(--text-secondary)]">
          Auto selected{" "}
          <span className="text-[var(--text-primary)]">
            {getProviderEmoji(provider)} {selectionInfo.label}
          </span>
        </div>
        <div className="text-[11px] text-[var(--text-muted)] mt-0.5 leading-relaxed">
          {selectionInfo.reason}
        </div>
      </div>
    </div>
  );
}

/** Action bar shown below generated images: download + try again. */
function ImageActions({
  imageUrls,
  message,
}: {
  imageUrls: string[];
  message: ChatMessageType;
}) {
  const models = useChatStore((s) => s.models);
  const retryGenerateImage = useChatStore((s) => s.retryGenerateImage);
  const isGeneratingImage = useChatStore((s) => s.isGeneratingImage);
  const [downloading, setDownloading] = useState<string | null>(null);

  // Extract prompt from message content (after "*Prompt: ") or use the message model info
  const promptMatch = message.content.match(/\*Prompt: (.+)\*/);
  const prompt = promptMatch ? promptMatch[1].trim() : "";
  const usedModelId = message.model;

  // Check if there are alternative models to try
  const genModels = models.filter((m) => m.supportsImageGen);
  const hasAlternative = usedModelId
    ? genModels.some((m) => m.id !== usedModelId)
    : genModels.length > 0;

  const handleDownload = useCallback(async (url: string, index: number) => {
    setDownloading(`img-${index}`);
    try {
      // Fetch the image and trigger a download via blob URL
      const res = await fetch(url);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `generated-image-${index + 1}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch {
      // Fallback: open in new tab
      window.open(url, "_blank");
    } finally {
      setDownloading(null);
    }
  }, []);

  const handleRetry = useCallback(() => {
    if (!prompt || !usedModelId || isGeneratingImage) return;
    retryGenerateImage(prompt, usedModelId, message.conversation_id);
  }, [prompt, usedModelId, message.conversation_id, isGeneratingImage, retryGenerateImage]);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 px-1">
      {/* Download buttons for each image */}
      {imageUrls.map((url, i) => (
        <button
          key={i}
          onClick={() => handleDownload(url, i)}
          disabled={downloading === `img-${i}`}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium
            bg-[var(--bg-card)] border border-[var(--border-subtle)]
            text-[var(--text-secondary)]
            hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]
            hover:border-[var(--border-hover)]
            transition-all duration-150
            disabled:opacity-50 disabled:cursor-not-allowed"
          title={`Download image ${i + 1}`}
        >
          <Download className="h-3.5 w-3.5" />
          {downloading === `img-${i}` ? "Downloading…" : `Download (${i + 1})`}
        </button>
      ))}

      {/* Try again with different model */}
      {hasAlternative && (
        <button
          onClick={handleRetry}
          disabled={isGeneratingImage}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium
            bg-[var(--bg-card)] border border-[var(--border-subtle)]
            text-[var(--text-secondary)]
            hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]
            hover:border-[var(--border-hover)]
            transition-all duration-150
            disabled:opacity-50 disabled:cursor-not-allowed"
          title="Generate this image again with a different model"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isGeneratingImage ? "animate-spin" : ""}`} />
          {isGeneratingImage ? "Generating…" : "Try different model"}
        </button>
      )}
    </div>
  );
}

/** Extract all /api/files/ image URLs from markdown content. */
function extractImageUrls(content: string): string[] {
  const urls: string[] = [];
  const regex = /!\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const url = match[1];
    // Only include URLs that point to our file server (exclude data URIs)
    if (url.startsWith("/api/files/")) {
      urls.push(url);
    }
  }
  return urls;
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
