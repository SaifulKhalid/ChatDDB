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
    priority: 2,
    costTier: 1,
    models: [
      "workers-ai:@cf/mistral/mistral-7b-instruct-v0.3",
      "workers-ai:@cf/meta/llama-3.2-11b-vision-instruct",
      "workers-ai:@cf/black-forest-labs/flux-1-schnell",
    ],
    capabilities: ["chat", "coding", "vision", "fast", "cheap", "image-generation"],
  },
  {
    provider: "gemini",
    priority: 3,
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
    priority: 4,
    costTier: 3,
    models: ["agentrouter:gpt-5.6-sol", "agentrouter:claude-opus-4-8"],
    capabilities: ["chat", "coding", "reasoning", "math", "creative", "premium"],
  },
  {
    provider: "openrouter",
    priority: 5,
    costTier: 1,
    models: [
      "openrouter:black-forest-labs/flux-1-schnell:free",
      "openrouter:black-forest-labs/flux-pro:free",
    ],
    capabilities: ["image-generation", "image-editing", "cheap"],
  },
];
