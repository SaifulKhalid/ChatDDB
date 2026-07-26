/**
 * Auto Model Selection Engine for ChatDDB.
 *
 * Handles:
 * 1. Intent classification — determines required capabilities from the request
 * 2. Model selection — scores providers by capabilities, health, cost, and priority
 * 3. Fallback — when the primary provider fails, select the next best alternative
 */
import { PROVIDER_CONFIGS } from "./capabilities";
import { healthTracker } from "./health-tracker";
import { MODELS } from "./types";
import type { Capability, ModelSelection, AttachmentMeta } from "./types";

/* ─── Intent Classification ─────────────────────────── */

const CODE_PATTERN = /```|function |const |import |export |class |def |fn |impl |interface|type |=>|async |await |Promise/i;

const REASONING_PATTERN =
  /why|how|explain|reason|analyze|compare|contrast|evaluate|prove|derive|what if|difference between/i;

const MATH_PATTERN =
  /calculate|solve|equation|derivative|integral|matrix|√|π|\+|-|\*|\/|=|≥|≤|∑|∫|dx|algebra|geometry|calculus/i;

const CREATIVE_PATTERN =
  /write a|story|poem|creative|imagine|generate|design|create|draft|compose/i;

/**
 * Classify a user request to determine the required AI capabilities.
 */
function classifyRequest(
  message: string,
  attachments: AttachmentMeta[],
  historyLength: number
): Set<Capability> {
  const caps = new Set<Capability>(["chat"]); // Chat is always the baseline

  const text = message;

  // File-based classification
  if (attachments.some((a) => a.kind === "image")) caps.add("vision");
  if (attachments.some((a) => a.kind === "pdf")) caps.add("pdf-analysis");

  // Content-based classification
  if (CODE_PATTERN.test(text)) caps.add("coding");
  if (REASONING_PATTERN.test(text)) caps.add("reasoning");
  if (MATH_PATTERN.test(text)) caps.add("math");
  if (CREATIVE_PATTERN.test(text)) caps.add("creative");

  // When coding is detected, remove creative — coding requests often start with
  // "write a" (e.g., "write a function") which matches the creative pattern but
  // isn't genuinely creative. This ensures Groq (coding-capable, cheapest) is
  // preferred for coding tasks rather than being outscored by Gemini.
  if (caps.has("coding") && caps.has("creative")) caps.delete("creative");

  // Context-based classification
  if (text.length > 500 || historyLength > 20) caps.add("long-context");

  return caps;
}

/* ─── Human-Readable Reasons ────────────────────────── */

/** Map capabilities to user-friendly descriptions. */
const CAPABILITY_LABELS: Record<Capability, string> = {
  chat: "Chat request",
  coding: "Code detected",
  reasoning: "Complex reasoning",
  math: "Math & equations",
  creative: "Creative task",
  vision: "Image attached",
  "pdf-analysis": "Document attached",
  "long-context": "Long conversation",
  fast: "",
  cheap: "",
  premium: "",
};

/** Cost tier labels for the reason summary. */
const COST_NOTES: Record<number, string> = {
  1: "Cheapest option",
  2: "Great value",
  3: "Premium quality",
};

/** Provider display names for fallback messages. */
const PROVIDER_NAMES: Record<string, string> = {
  groq: "Groq",
  gemini: "Gemini",
  agentrouter: "AgentRouter",
  openrouter: "OpenRouter",
  "workers-ai": "Workers AI",
};

/**
 * Build a human-readable reason string from the detected capabilities, score, and cost tier.
 */
function buildFriendlyReason(
  requiredCaps: Set<Capability>,
  costTier: number
): string {
  const parts: string[] = [];

  // Add capability descriptions (skip internal ones like fast, cheap, premium)
  for (const cap of requiredCaps) {
    const label = CAPABILITY_LABELS[cap];
    if (label) parts.push(label);
  }

  // Add cost note
  const costNote = COST_NOTES[costTier];
  if (costNote) parts.push(costNote);

  // If we have no parts (shouldn't happen since chat is always added), fall back
  if (parts.length === 0) parts.push("General chat");

  return parts.join(" · ");
}

/**
 * Build a friendly reason for fallback scenarios.
 */
function buildFallbackReason(
  provider: string,
  failedProvider: string
): string {
  const primaryName = PROVIDER_NAMES[failedProvider] || failedProvider;
  const fallbackName = PROVIDER_NAMES[provider] || provider;
  return `${primaryName} unavailable · Switched to ${fallbackName}`;
}

/* ─── Model Selection ───────────────────────────────── */

/**
 * Score a provider configuration against the required capabilities and current health.
 * Lower score = better match.
 */
function scoreProvider(
  config: typeof PROVIDER_CONFIGS[0],
  requiredCaps: Set<Capability>
): number {
  const health = healthTracker.getHealth(config.provider);

  // Capability penalty: 100 per missing required capability
  let capabilityPenalty = 0;
  for (const cap of requiredCaps) {
    if (!config.capabilities.includes(cap)) capabilityPenalty += 100;
  }

  // Health penalty
  const healthPenalty =
    health.status === "unhealthy"
      ? 200
      : health.status === "degraded"
        ? 50
        : 0;

  // Base score: priority (lower = better) + cost tier scaled
  const baseScore = config.priority * 10 + config.costTier * 5;

  return capabilityPenalty + healthPenalty + baseScore;
}

/**
 * Pick the best model ID from a provider's model list that supports the required capabilities.
 * Falls back to the first model if no capability-specific match is needed.
 */
function pickBestModel(
  providerConfig: typeof PROVIDER_CONFIGS[0],
  requiredCaps: Set<Capability>
): string {
  // If vision is required but the default model doesn't support it, find one that does
  if (requiredCaps.has("vision")) {
    const visionModelId = providerConfig.models.find((mId) => {
      const model = MODELS.find((m) => m.id === mId);
      return model?.supportsVision === true;
    });
    if (visionModelId) return visionModelId;
  }
  // Fall back to the first model
  return providerConfig.models[0];
}

/**
 * Select the best model for a user request in auto mode.
 */
export function selectAutoModel(
  message: string,
  attachments: AttachmentMeta[],
  historyLength: number
): ModelSelection {
  const requiredCaps = classifyRequest(message, attachments, historyLength);

  const scored = PROVIDER_CONFIGS
    .map((pc) => ({
      pc,
      score: scoreProvider(pc, requiredCaps),
    }))
    .sort((a, b) => a.score - b.score);

  const best = scored[0];
  const modelId = pickBestModel(best.pc, requiredCaps);
  const reason = buildFriendlyReason(
    requiredCaps,
    best.pc.costTier
  );

  return { modelId, provider: best.pc.provider, reason };
}

/**
 * Select a fallback model when the primary provider fails.
 * Returns null if no compatible healthy provider is available.
 */
export function selectFallbackModel(
  failedProvider: string,
  message: string,
  attachments: AttachmentMeta[],
  historyLength: number
): ModelSelection | null {
  const requiredCaps = classifyRequest(message, attachments, historyLength);

  const scored = PROVIDER_CONFIGS
    .filter((pc) => pc.provider !== failedProvider)
    .map((pc) => ({
      pc,
      score: scoreProvider(pc, requiredCaps),
    }))
    .filter((c) => {
      // Exclude unhealthy providers entirely for fallback
      const health = healthTracker.getHealth(c.pc.provider);
      return health.status !== "unhealthy";
    })
    .sort((a, b) => a.score - b.score);

  if (scored.length === 0) return null;

  const best = scored[0];
  const modelId = pickBestModel(best.pc, requiredCaps);
  const reason = buildFallbackReason(best.pc.provider, failedProvider);
  return {
    modelId,
    provider: best.pc.provider,
    reason,
  };
}
