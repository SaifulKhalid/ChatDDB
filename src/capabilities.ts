/**
 * Provider capability registry — single source of truth for provider metadata.
 *
 * Add a new provider here when integrating a new AI provider.
 * No other file needs to be edited for routing/capability awareness.
 */
import type { ProviderConfig } from "./types";

export const PROVIDER_CONFIGS: ProviderConfig[] = [
  {
    provider: "groq",
    priority: 1,
    costTier: 1,
    models: ["groq:llama-3.1-8b-instant"],
    capabilities: ["chat", "coding", "reasoning", "fast", "cheap"],
  },
  {
    provider: "workers-ai",
    priority: 3,
    costTier: 1,
    models: [
      "workers-ai:@cf/meta/llama-4-scout-17b-16e-instruct",
      "workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "workers-ai:@cf/qwen/qwen3-30b-a3b-fp8",
      "workers-ai:@cf/black-forest-labs/flux-1-schnell",
      "workers-ai:@cf/leonardo/lucid-origin",
    ],
    capabilities: ["chat", "coding", "vision", "fast", "cheap", "image-generation"],
  },
  {
    provider: "gemini",
    priority: 4,
    costTier: 2,
    models: ["gemini:gemini-2.5-flash"],
    capabilities: [
      "chat",
      "coding",
      "reasoning",
      "math",
      "creative",
      "vision",
      "pdf-analysis",
      "long-context",
    ],
  },
  {
    provider: "agentrouter",
    priority: 2,
    costTier: 3,
    models: ["agentrouter:claude-opus-4-8", "agentrouter:gpt-5.6-sol"],
    capabilities: ["chat", "coding", "reasoning", "math", "creative", "premium"],
  },
  {
    provider: "openrouter",
    priority: 5,
    costTier: 1,
    models: ["openrouter:inclusionai/ling-3.0-flash:free"],
    capabilities: ["chat", "cheap"],
  },
];
