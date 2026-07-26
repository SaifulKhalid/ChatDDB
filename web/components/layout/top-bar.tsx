"use client";

import { PanelLeft, ChevronDown, Search, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/ui/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Dropdown,
  DropdownTrigger,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
} from "@/components/ui/dropdown";
import { Avatar } from "@/components/ui/avatar";
import { useChatStore } from "@/stores/chat-store";
import { useUIStore } from "@/stores/ui-store";
import { getProviderEmoji } from "@/lib/constants";
import type { ModelInfo } from "@/lib/api";

export function TopBar() {
  const {
    models,
    currentModelId,
    setCurrentModel,
    activeConversationTitle,
    messages,
  } = useChatStore();
  const { sidebarOpen, setSidebarOpen } = useUIStore();

  const currentModel = models.find((m) => m.id === currentModelId);
  const grouped = groupModels(models);

  // Get the last user message for the query pill
  const lastUserMessage = [...messages]
    .reverse()
    .find((m) => m.role === "user");
  const lastUserText = lastUserMessage?.content || "";

  return (
    <header className="flex h-14 items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-primary)] px-3">
      <div className="flex items-center gap-2 min-w-0">
        {!sidebarOpen && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSidebarOpen(true)}
            title="Open sidebar"
          >
            <PanelLeft className="h-4 w-4" />
          </Button>
        )}
        <Logo size={22} />
        <span className="hidden sm:block truncate text-sm font-medium text-[var(--text-secondary)]">
          {activeConversationTitle}
        </span>
      </div>

      <div className="flex items-center gap-2">
        {/* User query pill — shows the last user message */}
        {lastUserText && (
          <div
            className="hidden md:flex items-center gap-2 max-w-[280px]
              px-3 py-1.5 rounded-full
              bg-[var(--bg-card)] border border-[var(--border-subtle)]
              text-xs text-[var(--text-secondary)]
              truncate"
            title={lastUserText}
          >
            <span className="shrink-0 text-[10px] text-[var(--text-muted)] font-medium uppercase tracking-wider">
              Ask
            </span>
            <span className="truncate">{lastUserText}</span>
          </div>
        )}

        {/* Model selector dropdown */}
        <Dropdown>
          <DropdownTrigger asChild>
            <Button
              variant="ghost"
              className="gap-1.5 rounded-lg px-3 text-sm font-medium text-[var(--text-primary)]"
            >
              {currentModel ? (
                <span>{getProviderEmoji(currentModel.provider)}</span>
              ) : null}
              <span className="max-w-[100px] truncate hidden sm:inline">
                {currentModel?.label?.split(" ")[0] || "Select model"}
              </span>
              <span className="sm:hidden truncate max-w-[60px]">
                {currentModel?.label?.split(" ")[0] || "AI"}
              </span>
              <ChevronDown className="h-3.5 w-3.5 text-[var(--text-muted)]" />
            </Button>
          </DropdownTrigger>
          <DropdownContent
            align="center"
            className="min-w-[260px] max-h-[60vh] overflow-y-auto"
          >
            {grouped.map((group) => (
              <div key={group.label}>
                <DropdownLabel>{group.label}</DropdownLabel>
                {group.models.map((m) => (
                  <DropdownItem
                    key={m.id}
                    active={m.id === currentModelId}
                    onClick={() => setCurrentModel(m.id)}
                  >
                    <span>{getProviderEmoji(m.provider)}</span>
                    <span className="flex-1 truncate">{m.label}</span>
                    {m.id === currentModelId && (
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-success)] shrink-0" />
                    )}
                  </DropdownItem>
                ))}
              </div>
            ))}
            {grouped.length === 0 && (
              <div className="px-3 py-4 text-center text-sm text-[var(--text-muted)]">
                No models available
              </div>
            )}
          </DropdownContent>
        </Dropdown>
      </div>

      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" title="Search (Ctrl+K)">
          <Search className="h-4 w-4" />
        </Button>
        <ThemeToggle />
        <Button variant="ghost" size="icon-sm" title="Notifications">
          <Bell className="h-4 w-4" />
        </Button>
        <Avatar fallback="U" size="sm" className="ml-1 cursor-pointer" />
      </div>
    </header>
  );
}

interface ModelGroup {
  label: string;
  models: ModelInfo[];
}

function groupModels(models: ModelInfo[]): ModelGroup[] {
  if (models.length === 0) return [];
  const vision = models.filter((m) => m.supportsVision);
  const text = models.filter((m) => !m.supportsVision);
  const groups: ModelGroup[] = [];
  if (text.length) groups.push({ label: "Text Models", models: text });
  if (vision.length) groups.push({ label: "Vision Models", models: vision });
  return groups;
}