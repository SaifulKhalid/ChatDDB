"use client";

import { useEffect, useRef, useState } from "react";
import {
  Paperclip,
  ArrowUp,
  Square,
  Sparkles,
  Loader2,
  ChevronDown,
} from "lucide-react";
import { useChatStore } from "@/stores/chat-store";
import { uploadFile } from "@/lib/api";
import { cn } from "@/lib/utils";
import { getProviderEmoji } from "@/lib/constants";
import type { AttachmentMeta } from "@/lib/api";

export function Composer() {
  const {
    sendMessage,
    stopStreaming,
    isStreaming,
    pendingAttachments,
    addPendingAttachment,
    removePendingAttachment,
    models,
    currentModelId,
    setCurrentModel,
  } = useChatStore();

  const [text, setText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  const currentModel = models.find((m) => m.id === currentModelId);

  // Listen for prefill events from suggestion cards
  useEffect(() => {
    function onPrefill(e: Event) {
      const detail = (e as CustomEvent).detail as string;
      setText(detail);
      textareaRef.current?.focus();
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
      });
    }
    window.addEventListener("chatddb-prefill", onPrefill);
    return () => window.removeEventListener("chatddb-prefill", onPrefill);
  }, []);

  // Auto-grow textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const maxHeight = 6 * 24;
    ta.style.height = Math.min(ta.scrollHeight, maxHeight) + "px";
  }, [text]);

  // Close model dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        modelDropdownRef.current &&
        !modelDropdownRef.current.contains(e.target as Node)
      ) {
        setModelDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleSend = () => {
    if ((!text.trim() && pendingAttachments.length === 0) || isStreaming)
      return;
    sendMessage(text.trim());
    setText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const { attachment } = await uploadFile(file);
        addPendingAttachment(attachment);
      }
    } catch (err) {
      console.error("Upload failed", err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const canSend = (text.trim() || pendingAttachments.length > 0) && !isStreaming;

  return (
    <div className="relative pb-5 pt-2 px-4">
      <div className="mx-auto max-w-[780px]">
        {/* Pending attachments */}
        {pendingAttachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingAttachments.map((att) => (
              <PendingAttachment
                key={att.id}
                att={att}
                onRemove={() => removePendingAttachment(att.id)}
              />
            ))}
          </div>
        )}

        {/* Floating pill-shaped input bar */}
        <div
          className="relative flex items-end gap-1.5
            rounded-full
            border border-[var(--border-subtle)]
            bg-[var(--bg-card)]
            px-3 py-2
            shadow-lg shadow-black/10
            transition-all duration-200
            focus-within:border-[var(--border-hover)]
            focus-within:shadow-xl focus-within:shadow-black/15"
        >
          {/* Attach button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full
              text-[var(--text-muted)] transition-colors
              hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]
              disabled:opacity-50"
            title="Attach file"
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Paperclip className="h-4 w-4" />
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFile}
            className="hidden"
            accept="image/*,.pdf,.txt,.md,.doc,.docx"
          />

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything"
            rows={1}
            className="max-h-[144px] flex-1 resize-none bg-transparent py-1.5
              text-[15px] leading-6
              text-[var(--text-primary)] placeholder:text-[var(--text-muted)]
              focus:outline-none"
          />

          {/* Model toggle with status dot */}
          <div className="relative shrink-0" ref={modelDropdownRef}>
            <button
              onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-full
                text-xs font-medium text-[var(--text-secondary)]
                bg-[var(--bg-hover)] hover:bg-[var(--bg-elevated)]
                transition-colors"
            >
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--accent-success)] opacity-40" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--accent-success)]" />
              </span>
              <span>{getProviderEmoji(currentModel?.provider || "")}</span>
              <span className="max-w-[60px] truncate hidden sm:inline">
                {currentModel?.label?.split(" ")[0] || "AI"}
              </span>
              <ChevronDown className="h-3 w-3 text-[var(--text-muted)]" />
            </button>

            {/* Model dropdown */}
            {modelDropdownOpen && (
              <div
                className="absolute bottom-full right-0 mb-2
                  min-w-[200px] rounded-xl
                  bg-[var(--bg-card)] border border-[var(--border-subtle)]
                  shadow-xl shadow-black/20
                  py-1 z-50
                  animate-fade-in"
              >
                {models.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => {
                      setCurrentModel(m.id);
                      setModelDropdownOpen(false);
                    }}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors",
                      m.id === currentModelId
                        ? "text-[var(--text-primary)] bg-[var(--bg-hover)]"
                        : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    )}
                  >
                    <span>{getProviderEmoji(m.provider)}</span>
                    <span className="flex-1 truncate">{m.label}</span>
                    {m.supportsVision && (
                      <span className="text-[10px] text-[var(--text-muted)] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)]">
                        Vision
                      </span>
                    )}
                    {m.id === currentModelId && (
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-success)] shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Prompt enhancer (sparkle) */}
          <button
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full
              text-[var(--text-muted)] transition-colors
              hover:bg-[var(--bg-hover)] hover:text-[var(--accent-primary)]"
            title="Enhance prompt"
          >
            <Sparkles className="h-4 w-4" />
          </button>

          {/* Send / Stop */}
          {isStreaming ? (
            <button
              onClick={stopStreaming}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full
                bg-[var(--text-primary)] text-[var(--bg-primary)]
                transition-transform active:scale-95"
              title="Stop"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSend}
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all active:scale-95",
                canSend
                  ? "bg-[var(--accent-primary)] text-white hover:brightness-110"
                  : "bg-[var(--bg-hover)] text-[var(--text-muted)]"
              )}
              title="Send"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PendingAttachment({
  att,
  onRemove,
}: {
  att: AttachmentMeta;
  onRemove: () => void;
}) {
  return (
    <div className="relative flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] py-1.5 pl-2 pr-7">
      <span className="text-base">
        {att.kind === "image" ? "🖼️" : att.kind === "pdf" ? "📄" : "📎"}
      </span>
      <span className="max-w-[140px] truncate text-xs text-[var(--text-primary)]">
        {att.name}
      </span>
      <span className="text-[10px] text-[var(--accent-primary)]">✓ Ready</span>
      <button
        onClick={onRemove}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--accent-danger)]"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
