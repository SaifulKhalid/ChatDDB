"use client";

import { motion } from "framer-motion";
import {
  Sparkles,
  Code2,
  Atom,
  Lightbulb,
  ArrowRight,
  Zap,
} from "lucide-react";
import { useChatStore } from "@/stores/chat-store";

const suggestions = [
  {
    icon: Code2,
    title: "Write code",
    description: "Build a React component",
    prompt: "Write a React component that displays a paginated data table with sorting and filtering",
  },
  {
    icon: Atom,
    title: "Explain concepts",
    description: "Quantum computing basics",
    prompt: "Explain quantum computing like I'm 10 years old",
  },
  {
    icon: Lightbulb,
    title: "Brainstorm",
    description: "Startup ideas in AI",
    prompt: "Give me 5 innovative startup ideas in the AI space for 2026",
  },
  {
    icon: Zap,
    title: "Analyze data",
    description: "SQL query writing",
    prompt: "Write a SQL query to find the top 10 most popular products by sales volume in the last quarter",
  },
];

export function WelcomeScreen() {
  const { sendMessage } = useChatStore();

  return (
    <div className="flex flex-col items-center justify-center h-full px-4 py-16 overflow-y-auto">
      {/* Logo */}
      <motion.div
        className="flex flex-col items-center gap-6 mb-12"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
      >
        <div className="relative">
          <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center shadow-lg shadow-[var(--accent-primary)]/20">
            <span className="text-2xl font-bold text-[var(--bg-primary)]">
              C
            </span>
          </div>
          {/* Glow effect */}
          <div
            className="absolute -inset-2 rounded-2xl opacity-20 blur-xl"
            style={{
              background:
                "linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))",
            }}
          />
        </div>

        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight mb-1">
            Welcome to{" "}
            <span className="gradient-text">ChatDDB</span>
          </h1>
          <p className="text-sm text-[var(--text-secondary)]">
            One Workspace. Every AI.
          </p>
        </div>

        {/* Quick stats */}
        <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
          <span className="flex items-center gap-1">
            <Sparkles className="h-3 w-3 text-[var(--accent-primary)]" />
            5 Models
          </span>
          <span className="w-1 h-1 rounded-full bg-[var(--border-default)]" />
          <span className="flex items-center gap-1">
            <Zap className="h-3 w-3 text-[var(--accent-secondary)]" />
            Streaming
          </span>
          <span className="w-1 h-1 rounded-full bg-[var(--border-default)]" />
          <span>Dark Mode</span>
        </div>
      </motion.div>

      {/* Suggestions */}
      <motion.div
        className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-lg mb-12"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
      >
        {suggestions.map((s, i) => (
          <motion.button
            key={s.title}
            className="group flex items-start gap-3 p-4 rounded-xl text-left
              bg-[var(--bg-card)] border border-[var(--border-subtle)]
              hover:border-[var(--border-hover)] hover:bg-[var(--bg-elevated)]
              transition-all duration-200"
            onClick={() => sendMessage(s.prompt)}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 + i * 0.07, duration: 0.3 }}
          >
            <div className="mt-0.5 h-8 w-8 rounded-lg bg-[var(--bg-secondary)] flex items-center justify-center shrink-0">
              <s.icon className="h-4 w-4 text-[var(--text-secondary)]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-primary)] transition-colors">
                {s.title}
              </div>
              <div className="text-xs text-[var(--text-muted)] mt-0.5 line-clamp-1">
                {s.description}
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5" />
          </motion.button>
        ))}
      </motion.div>

      {/* Keyboard shortcuts */}
      <motion.div
        className="flex items-center gap-4 text-xs text-[var(--text-muted)]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5, duration: 0.3 }}
      >
        <span className="flex items-center gap-1.5">
          <kbd className="px-1.5 py-0.5 rounded bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[10px] font-mono">
            ⌘K
          </kbd>
          Search
        </span>
        <span className="flex items-center gap-1.5">
          <kbd className="px-1.5 py-0.5 rounded bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[10px] font-mono">
            ⌘N
          </kbd>
          New chat
        </span>
        <span className="flex items-center gap-1.5">
          <kbd className="px-1.5 py-0.5 rounded bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[10px] font-mono">
            ⌘B
          </kbd>
          Toggle sidebar
        </span>
      </motion.div>
    </div>
  );
}
