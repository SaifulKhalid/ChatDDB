/**
 * Shared constants for ChatDDB.
 */

export const PROVIDER_ICONS: Record<string, string> = {
  groq: "⚡",
  gemini: "✨",
  agentrouter: "🌐",
};

export function getProviderEmoji(provider: string): string {
  return PROVIDER_ICONS[provider] || "🤖";
}

export function getModelEmoji(modelId: string | null): string {
  if (!modelId) return "🤖";
  const provider = modelId.split(":")[0];
  return getProviderEmoji(provider);
}

export const KEYBOARD_SHORTCUTS = {
  SEARCH: "k",
  NEW_CHAT: "n",
  TOGGLE_SIDEBAR: "b",
} as const;
