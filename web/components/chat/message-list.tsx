"use client";

import { useEffect, useRef } from "react";
import { useChatStore } from "@/stores/chat-store";
import { Message } from "./message";
import { WelcomeScreen } from "./welcome-screen";

export function MessageList() {
  const { messages, isStreaming } = useChatStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new content (no page jump)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  const isEmpty = messages.length === 0;

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto no-page-jump">
      {isEmpty ? (
        <WelcomeScreen />
      ) : (
        <div className="mx-auto flex max-w-chat flex-col gap-6 py-6">
          {messages.map((msg, i) => {
            const isLast = i === messages.length - 1;
            const streamingThis =
              isStreaming && isLast && msg.role === "assistant";
            return (
              <Message
                key={msg.id}
                message={msg}
                isStreaming={streamingThis}
              />
            );
          })}
          <div ref={bottomRef} className="h-4" />
        </div>
      )}
    </div>
  );
}