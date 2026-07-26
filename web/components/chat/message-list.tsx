"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useChatStore } from "@/stores/chat-store";
import { Message } from "./message";
import { WelcomeScreen } from "./welcome-screen";
import { cn } from "@/lib/utils";

export function MessageList() {
  const { messages, isStreaming } = useChatStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Show all messages (user + assistant)
  const displayMessages = messages;
  const isEmpty = messages.length === 0;

  // Track scroll position to show/hide scroll-to-bottom button
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = () => {
      const nearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 200;
      setShowScrollButton(!nearBottom);
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll to bottom on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [displayMessages]);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto no-page-jump scroll-smooth relative"
    >
      {isEmpty ? (
        <WelcomeScreen />
      ) : (
        <div className="mx-auto max-w-content py-8">
          {displayMessages.map((msg, i) => (
            <div
              key={msg.id}
              className={cn(
                "group",
                // Add spacing between messages
                i > 0 && "mt-6 pt-6 border-t border-[var(--border-subtle)]/50"
              )}
            >
              <Message
                message={msg}
                isStreaming={isStreaming && i === displayMessages.length - 1}
                isFirst={i === 0}
              />
            </div>
          ))}
          <div ref={bottomRef} className="h-4" />
        </div>
      )}

      {/* Floating scroll-to-bottom button */}
      {showScrollButton && !isEmpty && (
        <button
          onClick={scrollToBottom}            className="fixed md:bottom-28 bottom-24 left-1/2 -translate-x-1/2 z-10
            h-9 w-9 rounded-full
            bg-[var(--bg-card)] border border-[var(--border-subtle)]
            shadow-lg backdrop-blur-sm
            flex items-center justify-center
            text-[var(--text-muted)] hover:text-[var(--text-primary)]
            hover:border-[var(--border-hover)]
            transition-all duration-200
            animate-fade-in"
          title="Scroll to bottom"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
