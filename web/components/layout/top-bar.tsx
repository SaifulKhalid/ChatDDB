"use client";

import { useState, useRef, useEffect } from "react";
import { PanelLeft, ChevronDown, Search, LogOut, Settings, Shield } from "lucide-react";
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
import { useChatStore } from "@/stores/chat-store";
import { useGuestStore } from "@/stores/guest-store";
import { useUIStore } from "@/stores/ui-store";
import { getProviderEmoji } from "@/lib/constants";
import { useAuth } from "@/contexts/auth-context";
import { useRouter } from "next/navigation";
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
  const { user, logout } = useAuth();
  const { isGuest, remainingMessages } = useGuestStore();
  const router = useRouter();

  const currentModel = models.find((m) => m.id === currentModelId);
  const grouped = groupModels(models);

  // Get the last user message for the query pill
  const lastUserMessage = [...messages]
    .reverse()
    .find((m) => m.role === "user");
  const lastUserText = lastUserMessage?.content || "";

  // User menu dropdown state
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const userInitial = user?.name?.charAt(0)?.toUpperCase() || user?.email?.charAt(0)?.toUpperCase() || "U";

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

        {/* Guest mode badge */}
        {isGuest && (
          <button
            onClick={() => router.push("/login")}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg
              text-xs font-medium text-[var(--accent-secondary)]
              bg-[var(--accent-secondary)]/10 border border-[var(--accent-secondary)]/20
              hover:bg-[var(--accent-secondary)]/20 transition-colors"
            title={`${remainingMessages()} messages remaining — Sign in to save chats`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-secondary)]" />
            Guest
          </button>
        )}

        {/* User avatar with dropdown menu */}
        <div className="relative" ref={userMenuRef}>
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="flex items-center gap-2 ml-1 rounded-lg p-1 hover:bg-[var(--bg-hover)] transition-colors"
            title={user?.email || "User menu"}
          >
            {user?.picture ? (
              <img
                src={user.picture}
                alt=""
                className="h-7 w-7 rounded-full object-cover"
              />
            ) : (
              <div className="h-7 w-7 rounded-full bg-[var(--accent-primary)] flex items-center justify-center text-xs font-semibold text-white">
                {userInitial}
              </div>
            )}
          </button>

          {userMenuOpen && user && (
            <div
              className="absolute right-0 top-full mt-1 min-w-[200px] rounded-xl
                bg-[var(--bg-card)] border border-[var(--border-subtle)]
                shadow-xl shadow-black/20 py-1 z-50 animate-fade-in"
            >
              {/* User info header */}
              <div className="px-3 py-2.5 border-b border-[var(--border-subtle)]">
                <div className="text-sm font-medium text-[var(--text-primary)] truncate">
                  {user.name || "User"}
                </div>
                <div className="text-xs text-[var(--text-muted)] truncate mt-0.5">
                  {user.email}
                </div>
              </div>

              {/* Menu items */}
              <a
                href="/settings"
                className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-[var(--text-secondary)]
                  hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
              >
                <Settings className="h-4 w-4" />
                Settings
              </a>

              {user.isAdmin && (
                <a
                  href="/admin"
                  className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-[var(--text-secondary)]
                    hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                >
                  <Shield className="h-4 w-4" />
                  Admin Panel
                </a>
              )}

              <div className="mx-3 my-1 h-px bg-[var(--border-subtle)]" />

              <button
                onClick={logout}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-[var(--text-secondary)]
                  hover:bg-[var(--bg-hover)] hover:text-red-400 transition-colors"
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </button>
            </div>
          )}
        </div>
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