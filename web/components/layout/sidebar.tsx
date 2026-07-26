"use client";

import { useState, useEffect } from "react";
import {
  Search,
  Plus,
  MessageSquare,
  Trash2,
  Settings,
  PanelRightOpen,
  PanelRightClose,
  ChevronLeft,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { useUIStore } from "@/stores/ui-store";
import { useChatStore } from "@/stores/chat-store";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const { sidebarOpen, setSidebarOpen, toggleRightPanel, rightPanelOpen } =
    useUIStore();
  const {
    conversations,
    currentConversationId,
    models,
    currentModelId,
    loadConversations,
    selectConversation,
    newConversation,
    deleteConversation,
    setCurrentModel,
  } = useChatStore();

  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    loadConversations();
  }, []);

  const filteredConversations = conversations.filter((c) =>
    c.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <>
      {/* Mobile overlay */}
      <AnimatePresence>
        {sidebarOpen && (
          <motion.div
            className="fixed inset-0 bg-black/50 z-40 md:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSidebarOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <motion.aside
        className={cn(
          "fixed md:relative z-50 h-screen flex flex-col",
          "bg-[var(--bg-sidebar)] border-r border-[var(--border-subtle)]",
          "overflow-hidden"
        )}
        initial={false}
        animate={{
          width: sidebarOpen ? 280 : 0,
          minWidth: sidebarOpen ? 280 : 0,
        }}
        transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
      >
        <div className="flex flex-col h-full min-w-[280px]">
          {/* Header */}
          <div className="flex items-center justify-between px-4 h-14 shrink-0 border-b border-[var(--border-subtle)]">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-[var(--accent-primary)] flex items-center justify-center text-xs font-bold text-[var(--bg-primary)]">
                C
              </div>
              <span className="font-semibold text-sm tracking-tight">
                ChatDDB
              </span>
            </div>
            <div className="flex items-center gap-1">
              <ThemeToggle />
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setSidebarOpen(false)}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* New Chat */}
          <div className="px-3 pt-3 pb-2">
            <Button
              variant="secondary"
              size="default"
              className="w-full justify-start gap-2 text-sm h-10"
              onClick={newConversation}
            >
              <Plus className="h-4 w-4" />
              New Chat
            </Button>
          </div>

          {/* Search */}
          <div className="px-3 pb-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--text-muted)]" />
              <input
                type="text"
                placeholder="Search conversations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-9 pl-9 pr-3 rounded-lg text-sm
                  bg-[var(--bg-card)] border border-[var(--border-subtle)]
                  text-[var(--text-primary)] placeholder:text-[var(--text-muted)]
                  focus:outline-none focus:border-[var(--border-hover)]
                  transition-colors"
              />
            </div>
          </div>

          {/* Conversation list */}
          <div className="flex-1 overflow-y-auto px-2 py-1 space-y-0.5 scrollbar-hide">
            {filteredConversations.length === 0 && searchQuery && (
              <p className="text-xs text-[var(--text-muted)] text-center pt-8">
                No conversations found
              </p>
            )}
            {filteredConversations.length === 0 && !searchQuery && (
              <p className="text-xs text-[var(--text-muted)] text-center pt-8">
                No conversations yet
              </p>
            )}
            {filteredConversations.map((conv, i) => (
              <motion.button
                key={conv.id}
                className={cn(
                  "w-full group flex items-center gap-2 px-3 py-2.5 rounded-lg text-left text-sm transition-all duration-150",
                  conv.id === currentConversationId
                    ? "bg-[var(--bg-card)] text-[var(--text-primary)] border border-[var(--border-subtle)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] border border-transparent"
                )}
                onClick={() => {
                  selectConversation(conv.id);
                  // Close sidebar on mobile
                  if (window.innerWidth < 768) setSidebarOpen(false);
                }}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.02, duration: 0.2 }}
              >
                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                <span className="truncate flex-1">{conv.title}</span>
                <button
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-[var(--bg-elevated)]"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm("Delete this conversation?"))
                      deleteConversation(conv.id);
                  }}
                >
                  <Trash2 className="h-3 w-3 text-[var(--text-muted)] hover:text-[var(--accent-danger)]" />
                </button>
              </motion.button>
            ))}
          </div>

          {/* Model selector */}
          <div className="px-3 py-3 border-t border-[var(--border-subtle)]">
            <label className="text-xs text-[var(--text-muted)] font-medium mb-1.5 block">
              Active Model
            </label>
            <select
              value={currentModelId}
              onChange={(e) => setCurrentModel(e.target.value)}
              className="w-full h-9 px-3 rounded-lg text-sm
                bg-[var(--bg-card)] border border-[var(--border-subtle)]
                text-[var(--text-primary)]
                focus:outline-none focus:border-[var(--border-hover)]
                transition-colors cursor-pointer appearance-none"
              style={{
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%237A7A7A' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`,
                backgroundRepeat: "no-repeat",
                backgroundPosition: "right 10px center",
              }}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          {/* Bottom actions */}
          <div className="flex items-center justify-between px-3 py-3 border-t border-[var(--border-subtle)]">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleRightPanel}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                title={rightPanelOpen ? "Close panel" : "Open panel"}
              >
                {rightPanelOpen ? (
                  <PanelRightClose className="h-4 w-4" />
                ) : (
                  <PanelRightOpen className="h-4 w-4" />
                )}
              </Button>
              <a
                href="/settings"
                className="flex items-center justify-center w-8 h-8 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-all"
                title="Model Management"
              >
                <Settings className="h-4 w-4" />
              </a>
            </div>
          </div>
        </div>
      </motion.aside>
    </>
  );
}
