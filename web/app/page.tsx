"use client";

import { useEffect } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { RightPanel } from "@/components/layout/right-panel";
import { MessageList } from "@/components/chat/message-list";
import { Composer } from "@/components/chat/composer";
import { useChatStore } from "@/stores/chat-store";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

export default function Home() {
  const { loadModels, modelsLoaded } = useChatStore();

  useKeyboardShortcuts();

  useEffect(() => {
    if (!modelsLoaded) {
      loadModels();
    }
  }, [modelsLoaded, loadModels]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--bg-primary)]">
      {/* Sidebar */}
      <Sidebar />

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Top bar */}
        <TopBar />

        {/* Messages area */}
        <MessageList />

        {/* Composer */}
        <Composer />
      </div>

      {/* Right Panel */}
      <RightPanel />
    </div>
  );
}
