"use client";

import { useEffect } from "react";
import { useChatStore } from "@/stores/chat-store";
import { useUIStore } from "@/stores/ui-store";

/**
 * Global keyboard shortcuts:
 * - Ctrl/Cmd + K         -> search (toggle sidebar)
 * - Ctrl/Cmd + Shift + O -> new chat
 * - Ctrl/Cmd + /         -> focus prompt
 * - Esc                  -> close dialogs (sidebar on mobile)
 */
export function useKeyboardShortcuts() {
  const { newConversation } = useChatStore();
  const { setSidebarOpen, sidebarOpen } = useUIStore();

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSidebarOpen(!sidebarOpen);
        return;
      }

      if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        newConversation();
        return;
      }

      if (mod && e.key === "/") {
        e.preventDefault();
        const ta = document.querySelector<HTMLTextAreaElement>(
          'textarea[placeholder="Ask anything..."]'
        );
        ta?.focus();
        return;
      }

      if (e.key === "Escape") {
        if (window.innerWidth < 768) {
          setSidebarOpen(false);
        }
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [newConversation, setSidebarOpen, sidebarOpen]);
}