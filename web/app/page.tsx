"use client";

import { useEffect } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { RightPanel } from "@/components/layout/right-panel";
import { MessageList } from "@/components/chat/message-list";
import { Composer } from "@/components/chat/composer";
import { useChatStore } from "@/stores/chat-store";
import { useGuestStore } from "@/stores/guest-store";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { AuthGuard } from "@/components/auth/auth-guard";

export default function Home() {
  const { loadModels, modelsLoaded, setMessages } = useChatStore();
  const isGuest = useGuestStore((s) => s.isGuest);
  const guestMessages = useGuestStore((s) => s.messages);

  useKeyboardShortcuts();

  useEffect(() => {
    if (!modelsLoaded) {
      loadModels();
    }
  }, [modelsLoaded, loadModels]);

  // When in guest mode, restore messages from local storage
  useEffect(() => {
    if (isGuest && guestMessages.length > 0) {
      setMessages(guestMessages);
    }
  }, [isGuest]); // only run on mount when guest mode is active

  return (
    <AuthGuard>
      <div className="flex h-screen w-screen overflow-hidden bg-[var(--bg-primary)]">
        <Sidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <TopBar />
          <MessageList />
          <Composer />
        </div>
        <RightPanel />
      </div>
    </AuthGuard>
  );
}
