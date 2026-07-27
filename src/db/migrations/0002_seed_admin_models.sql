-- Migration 0002: Seed the admin_models table with the recommended default models.
-- These are the models that ship with the app out of the box.
-- Admins can edit, delete, or add more via the admin panel.
-- Uses INSERT OR IGNORE so this migration is safe to re-run.

-- ── Chat Models (ranked by speed/utility) ────────────────

INSERT OR IGNORE INTO admin_models (row_id, model_id, label, provider, supports_vision, supports_streaming)
VALUES ('seed-groq', 'groq:llama-3.1-8b-instant', 'Groq', 'groq', 0, 1);

INSERT OR IGNORE INTO admin_models (row_id, model_id, label, provider, supports_vision, supports_streaming)
VALUES ('seed-llama-4-scout', 'workers-ai:@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout', 'workers-ai', 1, 1);

INSERT OR IGNORE INTO admin_models (row_id, model_id, label, provider, supports_vision, supports_streaming)
VALUES ('seed-llama-3.3-70b', 'workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'Llama 3.3 70B', 'workers-ai', 0, 1);

INSERT OR IGNORE INTO admin_models (row_id, model_id, label, provider, supports_vision, supports_streaming)
VALUES ('seed-qwen3-30b', 'workers-ai:@cf/qwen/qwen3-30b-a3b-fp8', 'Qwen3 30B', 'workers-ai', 0, 1);

INSERT OR IGNORE INTO admin_models (row_id, model_id, label, provider, supports_vision, supports_streaming)
VALUES ('seed-gemini', 'gemini:gemini-2.5-flash', 'Gemini 2.5 Flash', 'gemini', 1, 1);

INSERT OR IGNORE INTO admin_models (row_id, model_id, label, provider, supports_vision, supports_streaming)
VALUES ('seed-claude', 'agentrouter:claude-opus-4-8', 'Claude', 'agentrouter', 1, 1);

INSERT OR IGNORE INTO admin_models (row_id, model_id, label, provider, supports_vision, supports_streaming)
VALUES ('seed-chatgpt', 'agentrouter:gpt-5.6-sol', 'ChatGPT', 'agentrouter', 1, 1);

-- ── Fallback (lowest priority) ─────────────────────────

INSERT OR IGNORE INTO admin_models (row_id, model_id, label, provider, supports_vision, supports_streaming)
VALUES ('seed-ling', 'openrouter:inclusionai/ling-3.0-flash:free', 'Ling 3.0 Flash', 'openrouter', 0, 1);

-- ── Image Generation Models ───────────────────────────

INSERT OR IGNORE INTO admin_models (row_id, model_id, label, provider, supports_vision, supports_streaming)
VALUES ('seed-flux', 'workers-ai:@cf/black-forest-labs/flux-1-schnell', 'FLUX.1 Schnell', 'workers-ai', 0, 0);

INSERT OR IGNORE INTO admin_models (row_id, model_id, label, provider, supports_vision, supports_streaming)
VALUES ('seed-leonardo', 'workers-ai:@cf/leonardo/lucid-origin', 'Leonardo Lucid', 'workers-ai', 0, 0);
