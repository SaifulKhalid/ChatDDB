"use client";

import { useEffect } from "react";
import { Menu } from "lucide-react";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { RightPanel } from "@/components/layout/right-panel";
import { MessageList } from "@/components/chat/message-list";
import { Composer } from "@/components/chat/composer";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/ui/logo";
import { useChatStore } from "@/stores/chat-store";
import { useUIStore } from "@/stores/ui-store";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

export default function Home() {
  const { loadModels, modelsLoaded } = useChatStore();
  const { setSidebarOpen } = useUIStore();

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
        {/* Top bar (desktop + mobile) */}
        <TopBar />

        {/* Mobile-only compact bar with menu */}
        <div className="md:hidden flex items-center gap-2 px-3 h-11 border-b border-[var(--border-subtle)]">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="h-4 w-4" />
          </Button>
          <Logo size={20} showWordmark />
        </div>

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