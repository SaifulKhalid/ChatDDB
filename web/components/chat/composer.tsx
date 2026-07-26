"use client";

import { useEffect, useRef, useState } from "react";
import {
  Paperclip,
  Mic,
  ArrowUp,
  Square,
  X,
  FileText,
  Loader2,
} from "lucide-react";
import { useChatStore } from "@/stores/chat-store";
import { uploadFile } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AttachmentMeta } from "@/lib/api";

export function Composer() {
  const {
    sendMessage,
    stopStreaming,
    isStreaming,
    pendingAttachments,
    addPendingAttachment,
    removePendingAttachment,
  } = useChatStore();

  const [text, setText] = useState("");
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Listen for prefill events from suggestion cards
  useEffect(() => {
    function onPrefill(e: Event) {
      const detail = (e as CustomEvent).detail as string;
      setText(detail);
      textareaRef.current?.focus();
      // place cursor at end
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

  // Auto-grow textarea (max 8 lines)
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const maxHeight = 8 * 24; // ~8 lines
    ta.style.height = Math.min(ta.scrollHeight, maxHeight) + "px";
  }, [text]);

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
    <div className="border-t border-[var(--border-subtle)] bg-[var(--bg-primary)] px-4 pb-4 pt-2">
      <div className="mx-auto max-w-chat">
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

        <div className="flex items-end gap-2 rounded-3xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-2 transition-colors focus-within:border-[var(--border-hover)]">
          {/* Attach */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
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
            placeholder="Ask anything..."
            rows={1}
            className="max-h-[192px] flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-6 text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />

          {/* Mic */}
          <button
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            title="Voice input"
          >
            <Mic className="h-4 w-4" />
          </button>

          {/* Send / Stop */}
          {isStreaming ? (
            <button
              onClick={stopStreaming}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--bg-primary)] transition-transform active:scale-95"
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
        <p className="mt-1.5 text-center text-[11px] text-[var(--text-muted)]">
          ChatDDB can make mistakes. Check important info.
        </p>
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
      <FileText className="h-4 w-4 text-[var(--accent-primary)]" />
      <span className="max-w-[140px] truncate text-xs text-[var(--text-primary)]">
        {att.name}
      </span>
      <span className="text-[10px] text-[var(--accent-primary)]">✓ Ready</span>
      <button
        onClick={onRemove}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--accent-danger)]"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}