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
import type { Capability, ModelInfo, ModelSelection, AttachmentMeta, ProviderConfig } from "./types";

/* ─── Intent Classification ─────────────────────────── */

// ── Coding patterns ──
const CODE_PATTERN = /```|function |const |import |export |class |def |fn |impl |interface|type |=>|async |await |Promise|console\.log|return |npm |yarn |git |npx |wrangler|curl |fetch\(|axios|useState|useEffect|Component|props|React\./i;

// ── Reasoning & analysis patterns ──
const REASONING_PATTERN =
  /why|how|explain|reason|analyze|compare|contrast|evaluate|prove|derive|what if|difference between|describe the|break down|walk me through|think step by step|give me the pros and cons/i;

// ── Math / equation patterns ──
const MATH_PATTERN =
  /calculate|solve|equation|derivative|integral|matrix|√|π|\+|-|\*|\/|=|≥|≤|∑|∫|dx|algebra|geometry|calculus|percent|percentage|statistics|probability/i;

// ── Creative / writing patterns ──
const CREATIVE_PATTERN =
  /write a|story|poem|creative|imagine|generate|draft|compose|script|essay|article|blog post|newsletter|tweet|song|lyrics|dialogue|screenplay/i;

// ── Translation patterns ──
const TRANSLATION_PATTERN =
  /translate|translation|in (?:french|spanish|german|japanese|chinese|korean|italian|portuguese|russian|arabic|hindi)|(?:french|spanish|german|japanese|chinese|korean|italian|portuguese|russian|arabic|hindi) (?:to|translate)/i;

// ── Summarization patterns ──
const SUMMARIZATION_PATTERN =
  /summarize|summary|tl;dr|tldr|recap|in a nutshell|give me the key points|main ideas|key takeaways|bullet points|digest/i;

// ── Code review / debugging patterns ──
const CODE_REVIEW_PATTERN =
  /review this|code review|debug|bug|fix this|what\'s wrong|why is this broken|issue|error|not working|refactor|optimize|improve this code/i;

// ── Data / extraction patterns ──
const DATA_PATTERN =
  /extract|parse|convert|format|transform|scrape|crawl|migrate|normalize|clean (?:data|up)|reformat/i;

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
  if (CODE_PATTERN.test(text) || CODE_REVIEW_PATTERN.test(text)) caps.add("coding");
  if (REASONING_PATTERN.test(text)) caps.add("reasoning");
  if (MATH_PATTERN.test(text)) caps.add("math");
  if (CREATIVE_PATTERN.test(text)) caps.add("creative");
  if (TRANSLATION_PATTERN.test(text)) caps.add("reasoning"); // Translation benefits from reasoning models
  if (SUMMARIZATION_PATTERN.test(text)) caps.add("reasoning"); // Summarization benefits from reasoning models
  if (DATA_PATTERN.test(text)) caps.add("coding"); // Data tasks benefit from coding-capable models

  // When coding is detected, remove creative — coding requests often start with
  // "write a" (e.g., "write a function") which matches the creative pattern but
  // isn't genuinely creative. This ensures Groq (coding-capable, cheapest) is
  // preferred for coding tasks rather than being outscored by Gemini.
  if (caps.has("coding") && caps.has("creative")) caps.delete("creative");

  // Context-based classification
  // Also consider long-context earlier: if history exceeds 10 messages, add long-context
  if (text.length > 500 || historyLength > 10) caps.add("long-context");

  // For simple greetings or very short messages (< 10 chars), don't add extra capabilities
  // so the cheapest model is selected
  if (text.length < 10 && !caps.has("vision") && !caps.has("pdf-analysis")) {
    // Keep only "chat" — simple chat request, use cheapest
    caps.delete("reasoning");
    caps.delete("creative");
    caps.delete("math");
  }

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
  "image-generation": "Image generation",
  "image-editing": "Image editing",
  fast: "",
  cheap: "",
  premium: "",
};

/** Cost tier labels for the reason summary. */
const COST_NOTES: Record<number, string> = {
  1: "Best value",
  2: "Great balance",
  3: "Maximum capability",
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
  const health = healthTracker.getHealth(config.provider + ":chat");

  // Capability penalty: 100 per missing required capability
  let capabilityPenalty = 0;
  for (const cap of requiredCaps) {
    if (!config.capabilities.includes(cap)) capabilityPenalty += 100;
  }

  // Health penalty — aggressive for unhealthy or recently-failed providers
  const now = Date.now();
  const recentMs = 60_000; // 1 minute
  const recentlyFailed = health.lastFailure > 0 && (now - health.lastFailure) < recentMs;

  const healthPenalty =
    health.status === "unhealthy"
      ? 2000  // Very high: completely avoid
      : health.status === "degraded"
        ? 200
        : recentlyFailed
          ? 150  // Recently failed but not yet degraded — give a heavy penalty
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
  providerConfig: ProviderConfig,
  requiredCaps: Set<Capability>,
  mergedModels: ModelInfo[] = MODELS
): string {
  // If vision is required but the default model doesn't support it, find one that does
  if (requiredCaps.has("vision")) {
    const visionModelId = providerConfig.models.find((mId) => {
      const model = mergedModels.find((m) => m.id === mId);
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
  historyLength: number,
  mergedModels?: ModelInfo[]
): ModelSelection {
  const requiredCaps = classifyRequest(message, attachments, historyLength);

  const scored = PROVIDER_CONFIGS
    .map((pc) => ({
      pc,
      score: scoreProvider(pc, requiredCaps),
    }))
    .sort((a, b) => a.score - b.score);

  const best = scored[0];
  const modelId = pickBestModel(best.pc, requiredCaps, mergedModels);
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
  historyLength: number,
  mergedModels?: ModelInfo[]
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
      const health = healthTracker.getHealth(c.pc.provider + ":chat");
      return health.status !== "unhealthy";
    })
    .sort((a, b) => a.score - b.score);

  if (scored.length === 0) return null;

  const best = scored[0];
  const modelId = pickBestModel(best.pc, requiredCaps, mergedModels);
  const reason = buildFallbackReason(best.pc.provider, failedProvider);
  return {
    modelId,
    provider: best.pc.provider,
    reason,
  };
}

/* ─── Image Generation Model Selection ─────────────── */

/** In-memory counter to round-robin among equally-healthy image gen models. */
let imageModelRoundRobin = 0;

/**
 * Select the best image generation model, aware of editing capability and provider health.
 *
 * Round-robins among healthy models at the same health tier to distribute load
 * evenly rather than always hammering the first model (e.g., FLUX.1 Schnell via
 * OpenRouter while Workers AI FLUX sits idle).
 */
export function selectAutoImageModel(
  mergedModels: ModelInfo[],
  editing?: boolean
): ModelSelection {
  let candidates = mergedModels.filter((m) => m.supportsImageGen);
  if (candidates.length === 0) throw new Error("No image generation models available");

  if (editing) {
    const editingCandidates = candidates.filter((m) => m.supportsImageEditing);
    if (editingCandidates.length > 0) {
      candidates = editingCandidates;
    } else {
      throw new Error(
        "None of the available image generation models support image-to-image editing. " +
        "Editing requires an OpenRouter FLUX model."
      );
    }
  }

  // Score by health (namespaced under ":image")
  const scored = candidates
    .map((m) => {
      const health = healthTracker.getHealth(m.provider + ":image");
      let score = 0;
      if (health.status === "unhealthy") score += 100;
      else if (health.status === "degraded") score += 20;
      return { model: m, score };
    })
    .sort((a, b) => a.score - b.score);

  if (scored.length === 0) throw new Error("No image generation models available");

  // Round-robin within the same health tier to distribute load
  const bestScore = scored[0].score;
  const sameTier = scored.filter((s) => s.score === bestScore);
  const idx = imageModelRoundRobin % sameTier.length;
  // Prevent unbounded growth of the counter (cap at 1000)
  imageModelRoundRobin = (imageModelRoundRobin + 1) % 1000;
  const best = sameTier[idx];

  const reason = editing
    ? best.model.supportsImageEditing
      ? "Image editing · Auto-selected"
      : "Image generation · Auto-selected"
    : "Image generation · Auto-selected";

  return { modelId: best.model.id, provider: best.model.provider, reason };
}

/**
 * Select a fallback image model when the primary fails.
 * Returns null if no compatible healthy model is available.
 */
export function selectFallbackImageModel(
  failedModelId: string,
  mergedModels: ModelInfo[],
  editing?: boolean
): ModelSelection | null {
  let candidates = mergedModels.filter(
    (m) => m.supportsImageGen && m.id !== failedModelId
  );
  if (candidates.length === 0) return null;

  if (editing) {
    const editingCandidates = candidates.filter((m) => m.supportsImageEditing);
    // If editing is needed but no editing-capable models remain, return null immediately
    // to avoid a pointless retry loop where generateImage rejects non-editing models.
    if (editingCandidates.length === 0) return null;
    candidates = editingCandidates;
  }

  const scored = candidates
    .map((m) => {
      const health = healthTracker.getHealth(m.provider + ":image");
      let score = 0;
      if (health.status === "unhealthy") score += 100;
      else if (health.status === "degraded") score += 20;
      return { model: m, score };
    })
    .filter((c) => {
      const health = healthTracker.getHealth(c.model.provider + ":image");
      return health.status !== "unhealthy";
    })
    .sort((a, b) => a.score - b.score);

  if (scored.length === 0) return null;
  const best = scored[0];
  return {
    modelId: best.model.id,
    provider: best.model.provider,
    reason: "Failed · Auto-fallback",
  };
}
