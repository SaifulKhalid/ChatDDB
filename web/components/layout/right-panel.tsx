"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Code2,
  FileSearch,
  Info,
  X,
  FileText,
  Sparkles,
  Globe,
  Hash,
} from "lucide-react";
import { useUIStore } from "@/stores/ui-store";
import { useChatStore } from "@/stores/chat-store";
import { cn } from "@/lib/utils";

type Tab = "artifacts" | "sources" | "info";

const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "artifacts", label: "Artifacts", icon: Code2 },
  { id: "sources", label: "Sources", icon: FileSearch },
  { id: "info", label: "Info", icon: Info },
];

export function RightPanel() {
  const { rightPanelOpen, toggleRightPanel } = useUIStore();
  const { messages, currentModelId, models, activeConversationTitle } = useChatStore();
  const [activeTab, setActiveTab] = useState<Tab>("artifacts");

  const currentModel = models.find((m) => m.id === currentModelId);

  const hasContent = messages.length > 0;

  return (
    <>
      {/* Overlay for mobile */}
      <AnimatePresence>
        {rightPanelOpen && (
          <motion.div
            className="fixed inset-0 bg-black/30 z-30 lg:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={toggleRightPanel}
          />
        )}
      </AnimatePresence>

      {/* Panel */}
      <motion.aside
        className={cn(
          "fixed lg:relative right-0 top-0 z-40 h-screen flex flex-col",
          "bg-[var(--bg-secondary)] border-l border-[var(--border-subtle)]",
          "overflow-hidden"
        )}
        initial={false}
        animate={{
          width: rightPanelOpen ? 320 : 0,
          minWidth: rightPanelOpen ? 320 : 0,
        }}
        transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
      >
        <div className="flex flex-col h-full min-w-[320px]">
          {/* Header */}
          <div className="flex items-center justify-between px-4 h-14 shrink-0 border-b border-[var(--border-subtle)]">
            <span className="text-sm font-medium">Workspace</span>
            <button
              onClick={toggleRightPanel}
              className="h-7 w-7 flex items-center justify-center rounded-lg
                text-[var(--text-muted)] hover:text-[var(--text-primary)]
                hover:bg-[var(--bg-card)] transition-all"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-[var(--border-subtle)]">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 h-10 text-xs font-medium transition-colors relative",
                  activeTab === tab.id
                    ? "text-[var(--text-primary)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                )}
              >
                <tab.icon className="h-3.5 w-3.5" />
                {tab.label}
                {activeTab === tab.id && (
                  <motion.div
                    className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--accent-primary)]"
                    layoutId="activePanelTab"
                    transition={{ duration: 0.2 }}
                  />
                )}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto scrollbar-hide">
            {!hasContent ? (
              <div className="flex flex-col items-center justify-center h-full px-6 text-center">
                <div className="h-12 w-12 rounded-xl bg-[var(--bg-card)] flex items-center justify-center mb-3">
                  <Sparkles className="h-5 w-5 text-[var(--text-muted)]" />
                </div>
                <p className="text-sm text-[var(--text-secondary)] font-medium">
                  No active conversation
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  Start a chat to see artifacts, sources, and info here.
                </p>
              </div>
            ) : (
              <div className="p-4 space-y-4">
                {activeTab === "info" && (
                  <div className="space-y-4">
                    {/* Conversation Info */}
                    <div>
                      <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">
                        Conversation
                      </h4>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-sm">
                          <Hash className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                          <span className="text-[var(--text-secondary)] truncate">
                            {activeConversationTitle}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                          <Sparkles className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
                          <span className="text-[var(--text-secondary)]">
                            {currentModel?.label || "AI"}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                          <FileText className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                          <span className="text-[var(--text-secondary)]">
                            {messages.length} messages
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                          <Globe className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                          <span className="text-[var(--text-secondary)] capitalize">
                            {currentModel?.provider || "ai"}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Attachments */}
                    {messages.some((m) => m.attachments.length > 0) && (
                      <div>
                        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">
                          Files
                        </h4>
                        <div className="space-y-1.5">
                          {messages
                            .flatMap((m) => m.attachments)
                            .filter((a, i, arr) => arr.findIndex((x) => x.id === a.id) === i)
                            .map((att) => (
                              <div
                                key={att.id}
                                className="flex items-center gap-2 px-3 py-2 rounded-lg
                                  bg-[var(--bg-card)] border border-[var(--border-subtle)] text-sm"
                              >
                                <span className="text-base">
                                  {att.kind === "image" ? "🖼️" : att.kind === "pdf" ? "📄" : "📎"}
                                </span>
                                <span className="text-[var(--text-secondary)] truncate flex-1 text-xs">
                                  {att.name}
                                </span>
                                <span className="text-[10px] text-[var(--text-muted)]">
                                  {(att.size / 1024).toFixed(1)} KB
                                </span>
                              </div>
                            ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "artifacts" && (
                  <div className="flex flex-col items-center justify-center h-40 text-center">
                    <Code2 className="h-6 w-6 text-[var(--text-muted)] mb-2" />
                    <p className="text-xs text-[var(--text-muted)]">
                      Code artifacts will appear here when the AI generates them.
                    </p>
                  </div>
                )}

                {activeTab === "sources" && (
                  <div className="flex flex-col items-center justify-center h-40 text-center">
                    <Globe className="h-6 w-6 text-[var(--text-muted)] mb-2" />
                    <p className="text-xs text-[var(--text-muted)]">
                      Web sources will appear here when the AI searches the internet.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </motion.aside>
    </>
  );
}
