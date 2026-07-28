#!/usr/bin/env node

/**
 * Model availability checker.
 *
 * Queries each provider's API to verify that the models configured
 * in the codebase are still valid and accessible.
 */

/* ─── All configured models ─────────────────────────── */

const MODELS = [
  // Groq
  { id: "groq:llama-3.1-8b-instant", provider: "groq", type: "chat", apiModel: "llama-3.1-8b-instant" },
  // Gemini
  { id: "gemini:gemini-2.5-flash", provider: "gemini", type: "chat", apiModel: "gemini-2.5-flash" },
  // AgentRouter
  { id: "agentrouter:kimi-k3", provider: "agentrouter", type: "chat", apiModel: "kimi-k3" },
  { id: "agentrouter:claude-opus-4-8", provider: "agentrouter", type: "chat", apiModel: "claude-opus-4-8" },
  { id: "agentrouter:gpt-5.6-sol", provider: "agentrouter", type: "chat", apiModel: "gpt-5.6-sol" },
  // Workers AI (chat)
  { id: "workers-ai:@cf/mistral/mistral-7b-instruct-v0.3", provider: "workers-ai", type: "chat", apiModel: "@cf/mistral/mistral-7b-instruct-v0.3" },
  { id: "workers-ai:@cf/meta/llama-3.2-11b-vision-instruct", provider: "workers-ai", type: "chat", apiModel: "@cf/meta/llama-3.2-11b-vision-instruct" },
  { id: "workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast", provider: "workers-ai", type: "chat", apiModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  { id: "workers-ai:@hf/google/gemma-2-27b-it", provider: "workers-ai", type: "chat", apiModel: "@hf/google/gemma-2-27b-it" },
  // OpenRouter (chat)
  { id: "openrouter:poolside/laguna-s-2.1:free", provider: "openrouter", type: "chat", apiModel: "poolside/laguna-s-2.1:free" },
  { id: "openrouter:openrouter/free", provider: "openrouter", type: "chat", apiModel: "openrouter/free" },
  { id: "openrouter:inclusionai/ling-3.0-flash:free", provider: "openrouter", type: "chat", apiModel: "inclusionai/ling-3.0-flash:free" },
  { id: "openrouter:openai/gpt-oss-20b:free", provider: "openrouter", type: "chat", apiModel: "openai/gpt-oss-20b:free" },
  { id: "openrouter:google/gemma-4-26b-a4b-it:free", provider: "openrouter", type: "chat", apiModel: "google/gemma-4-26b-a4b-it:free" },
  // Image generation models
  { id: "openrouter:black-forest-labs/flux-1-schnell:free", provider: "openrouter", type: "image", apiModel: "black-forest-labs/flux-1-schnell:free" },
  { id: "openrouter:black-forest-labs/flux-pro:free", provider: "openrouter", type: "image", apiModel: "black-forest-labs/flux-pro:free" },
  { id: "workers-ai:@cf/black-forest-labs/flux-1-schnell", provider: "workers-ai", type: "image", apiModel: "@cf/black-forest-labs/flux-1-schnell" },
];

async function checkOpenRouterModels() {
  console.log("\n── OpenRouter Models ──");
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.log(`  API returned ${res.status} — can't verify`);
      return { available: [], missing: MODELS.filter(m => m.provider === "openrouter").map(m => m.apiModel) };
    }
    const data = await res.json();
    const availableIds = new Set(data.data.map(m => m.id));

    const openRouterModels = MODELS.filter(m => m.provider === "openrouter");
    const available = [];
    const missing = [];
    for (const model of openRouterModels) {
      if (availableIds.has(model.apiModel)) {
        available.push(model);
        console.log(`  ✓ ${model.apiModel} — available`);
      } else {
        missing.push(model);
        console.log(`  ✗ ${model.apiModel} — NOT FOUND on OpenRouter`);
      }
    }
    return { available, missing };
  } catch (err) {
    console.log(`  Error: ${err.message}`);
    return { available: [], missing: MODELS.filter(m => m.provider === "openrouter") };
  }
}

async function checkGroqModels() {
  console.log("\n── Groq Models ──");
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.log(`  API returned ${res.status} — can't verify (API key may be required)`);
      return { unknown: true };
    }
    const data = await res.json();
    const availableIds = new Set(data.data.map(m => m.id));

    for (const model of MODELS.filter(m => m.provider === "groq")) {
      if (availableIds.has(model.apiModel)) {
        console.log(`  ✓ ${model.apiModel} — available`);
      } else {
        console.log(`  ✗ ${model.apiModel} — NOT FOUND`);
      }
    }
  } catch (err) {
    console.log(`  Error: ${err.message} (may require API key)`);
  }
  return { unknown: true };
}

async function checkWorkersAIModels() {
  console.log("\n── Workers AI Models ──");
  console.log("  (Cloudflare Workers AI models are available at runtime via env.AI binding)");
  console.log("  Cannot verify remotely — assume available.");
  for (const model of MODELS.filter(m => m.provider === "workers-ai")) {
    console.log(`  ? ${model.apiModel} — assumed available (CF Workers AI)`);
  }
}

async function checkAgentRouterModels() {
  console.log("\n── AgentRouter Models ──");
  try {
    const res = await fetch("https://agentrouter.org/v1/models", {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.log(`  API returned ${res.status} — can't verify`);
      return;
    }
    const data = await res.json();
    const availableIds = new Set(data.data.map(m => m.id));

    for (const model of MODELS.filter(m => m.provider === "agentrouter")) {
      if (availableIds.has(model.apiModel)) {
        console.log(`  ✓ ${model.apiModel} — available`);
      } else {
        console.log(`  ✗ ${model.apiModel} — NOT FOUND`);
      }
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }
}

async function checkGeminiModels() {
  console.log("\n── Gemini Models ──");
  console.log("  (Gemini models require API key to list — cannot verify remotely)");
  console.log("  ? gemini-2.5-flash — assumed available");
}

async function main() {
  console.log("═ Model Availability Report ════════════════════════════════");
  console.log(`Generated: ${new Date().toISOString()}\n`);

  const orResult = await checkOpenRouterModels();
  await checkGroqModels();
  await checkAgentRouterModels();
  await checkGeminiModels();
  await checkWorkersAIModels();

  // Summary
  console.log("\n══ Summary ═════════════════════════════════════════════════");
  const total = MODELS.length;
  const orMissing = orResult.missing?.length || 0;
  const orAvailable = orResult.available?.length || 0;
  const unknown = MODELS.length - orAvailable - orMissing;
  console.log(`  Total configured models: ${total}`);
  console.log(`  OpenRouter models: ${orAvailable} available, ${orMissing} missing`);
  console.log(`  Other providers: ~${unknown} models (not remotely verifiable)`);

  if (orMissing > 0) {
    console.log("\n  ⚠ DEPRECATED MODELS (return 404):");
    console.log("  The following OpenRouter models are no longer available");
    console.log("  and need to be removed or replaced:");
    for (const m of orResult.missing || []) {
      console.log(`    - ${m.id}`);
    }
  }
}

main().catch(console.error);
