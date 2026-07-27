-- Migration 0003: Fix admin_models provider CHECK constraint to include 'workers-ai'
-- and seed the missing Workers AI models + image generation models.
--
-- The original CHECK constraint was:
--   provider IN ('groq', 'gemini', 'agentrouter', 'openrouter')
-- It needs to include 'workers-ai' so admin-defined Workers AI models work.

-- Step 1: Create a new table with the corrected CHECK constraint
CREATE TABLE IF NOT EXISTS admin_models_new (
  row_id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('groq', 'gemini', 'agentrouter', 'openrouter', 'workers-ai')),
  supports_vision INTEGER NOT NULL DEFAULT 0,
  supports_streaming INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Step 2: Copy all existing data to the new table
INSERT OR IGNORE INTO admin_models_new (row_id, model_id, label, provider, supports_vision, supports_streaming, created_at)
SELECT row_id, model_id, label, provider, supports_vision, supports_streaming, created_at FROM admin_models;

-- Step 3: Drop the old table
DROP TABLE IF EXISTS admin_models;

-- Step 4: Rename the new table to the original name
ALTER TABLE admin_models_new RENAME TO admin_models;

-- Step 5: Insert the Workers AI chat models that couldn't be inserted before
INSERT OR IGNORE INTO admin_models (row_id, model_id, label, provider, supports_vision, supports_streaming)
VALUES ('seed-llama-4-scout', 'workers-ai:@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout', 'workers-ai', 1, 1);

INSERT OR IGNORE INTO admin_models (row_id, model_id, label, provider, supports_vision, supports_streaming)
VALUES ('seed-llama-3-3-70b', 'workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'Llama 3.3 70B', 'workers-ai', 0, 1);

INSERT OR IGNORE INTO admin_models (row_id, model_id, label, provider, supports_vision, supports_streaming)
VALUES ('seed-qwen3-30b', 'workers-ai:@cf/qwen/qwen3-30b-a3b-fp8', 'Qwen3 30B', 'workers-ai', 0, 1);

-- Step 6: Insert the image generation models
INSERT OR IGNORE INTO admin_models (row_id, model_id, label, provider, supports_vision, supports_streaming)
VALUES ('seed-flux', 'workers-ai:@cf/black-forest-labs/flux-1-schnell', 'FLUX.1 Schnell', 'workers-ai', 0, 0);

INSERT OR IGNORE INTO admin_models (row_id, model_id, label, provider, supports_vision, supports_streaming)
VALUES ('seed-leonardo', 'workers-ai:@cf/leonardo/lucid-origin', 'Leonardo Lucid', 'workers-ai', 0, 0);

-- Step 7: Recreate the index
CREATE INDEX IF NOT EXISTS idx_admin_models_provider ON admin_models(provider);
