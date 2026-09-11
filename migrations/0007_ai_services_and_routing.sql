-- ChatDDB Phase 3, migration 0007: Hidden Multi-AI Aggregation Platform.
--
-- Introduces dynamic AI Services, API Providers, Routes, and Route Health.
-- Additive: preserves all existing users, sessions, messages, files, and counters.

CREATE TABLE ai_services (
  id              TEXT PRIMARY KEY,             -- uuid
  key             TEXT NOT NULL UNIQUE,         -- 'chatgpt', 'gemini', 'grok', 'claude', 'deepseek', 'glm'
  public_name     TEXT NOT NULL,                -- 'ChatGPT', 'Gemini', 'Grok', 'Claude', etc.
  description     TEXT,
  capabilities    TEXT NOT NULL DEFAULT '{}',   -- JSON: {"vision": true, "documents": true, "reasoning": true, "tools": true}
  enabled         INTEGER NOT NULL DEFAULT 1,   -- 1 = true, 0 = false
  default_service INTEGER NOT NULL DEFAULT 0,   -- 1 = default, 0 = false
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_ai_services_enabled ON ai_services (enabled, sort_order);
CREATE INDEX idx_ai_services_key ON ai_services (key);

CREATE TABLE api_providers (
  id              TEXT PRIMARY KEY,             -- uuid
  key             TEXT NOT NULL UNIQUE,         -- 'agentrouter', 'codecraft'
  label           TEXT NOT NULL,                -- 'AgentRouter', 'CodeCraft API'
  adapter         TEXT NOT NULL DEFAULT 'openai', -- 'openai' | 'workersai' | 'pollinations'
  base_url        TEXT NOT NULL,
  credentials     TEXT NOT NULL DEFAULT '{}',   -- JSON: {"apiKey": "..."} or {"apiKeys": ["..."]}
  headers         TEXT,                         -- JSON: optional custom headers
  timeout_ms      INTEGER NOT NULL DEFAULT 180000,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_api_providers_enabled ON api_providers (enabled);
CREATE INDEX idx_api_providers_key ON api_providers (key);

CREATE TABLE ai_routes (
  id                TEXT PRIMARY KEY,           -- uuid
  service_id        TEXT NOT NULL REFERENCES ai_services (id) ON DELETE CASCADE,
  provider_id       TEXT NOT NULL REFERENCES api_providers (id) ON DELETE CASCADE,
  upstream_model_id TEXT NOT NULL,              -- internal model id on gateway (e.g. 'gpt-5.6-sol')
  priority          INTEGER NOT NULL DEFAULT 1, -- lower number = earlier attempt (1 before 2)
  weight            INTEGER NOT NULL DEFAULT 100,
  enabled           INTEGER NOT NULL DEFAULT 1,
  capabilities      TEXT,                       -- JSON route override
  configuration     TEXT,                       -- JSON: optional token/reasoning configuration
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX idx_ai_routes_service_prio ON ai_routes (service_id, priority ASC, enabled);
CREATE INDEX idx_ai_routes_provider ON ai_routes (provider_id);

CREATE TABLE route_health (
  route_id              TEXT PRIMARY KEY REFERENCES ai_routes (id) ON DELETE CASCADE,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  last_success_at       INTEGER,
  last_failure_at       INTEGER,
  last_latency_ms       INTEGER,
  last_error_class      TEXT,
  last_error_message    TEXT,
  circuit_until         INTEGER,                -- timestamp until which circuit is open
  updated_at            INTEGER NOT NULL
);

CREATE INDEX idx_route_health_circuit ON route_health (circuit_until);

-- Initial seed data
-- Timestamps: 1773000000000 (~March 2026)
INSERT INTO api_providers (id, key, label, adapter, base_url, credentials, headers, timeout_ms, enabled, created_at, updated_at)
VALUES
  ('prov-agentrouter', 'agentrouter', 'AgentRouter', 'openai', 'https://agentrouter.org/v1', '{}', '{"User-Agent":"claude-cli/2.1.158 (external, sdk-cli)","X-App":"cli"}', 180000, 1, 1773000000000, 1773000000000),
  ('prov-codecraft',   'codecraft',   'CodeCraft API', 'openai', 'https://codecraftapi.com/v1', '{}', NULL, 180000, 1, 1773000000000, 1773000000000);

INSERT INTO ai_services (id, key, public_name, description, capabilities, enabled, default_service, sort_order, created_at, updated_at)
VALUES
  ('srv-chatgpt',  'chatgpt',  'ChatGPT',  'Flagship general reasoning, coding, and multimodal intelligence.', '{"vision":true,"documents":true,"reasoning":true,"tools":true}', 1, 0, 1, 1773000000000, 1773000000000),
  ('srv-gemini',   'gemini',   'Gemini',   'Fast multimodal model with advanced reasoning and large context.', '{"vision":true,"documents":true,"reasoning":true,"tools":true}', 1, 0, 2, 1773000000000, 1773000000000),
  ('srv-claude',   'claude',   'Claude',   'Premier coding, nuanced reasoning, and agentic workflows.',       '{"vision":true,"documents":true,"reasoning":true,"tools":true}', 1, 0, 3, 1773000000000, 1773000000000),
  ('srv-deepseek', 'deepseek', 'DeepSeek', 'Fast, efficient technical model for coding and logic.',             '{"vision":false,"documents":true,"reasoning":true,"tools":true}', 1, 1, 4, 1773000000000, 1773000000000),
  ('srv-glm',      'glm',      'GLM',      'Strong technical reasoning and mathematical analysis.',            '{"vision":false,"documents":true,"reasoning":true,"tools":true}', 1, 0, 5, 1773000000000, 1773000000000),
  ('srv-grok',     'grok',     'Grok',     'Real-time conversational intelligence with direct answers.',       '{"vision":false,"documents":true,"reasoning":true,"tools":true}', 1, 0, 6, 1773000000000, 1773000000000);

INSERT INTO ai_routes (id, service_id, provider_id, upstream_model_id, priority, weight, enabled, capabilities, configuration, created_at, updated_at)
VALUES
  -- ChatGPT
  ('rt-chatgpt-1',  'srv-chatgpt',  'prov-codecraft',   'gpt-5.6-sol',        1, 100, 1, '{"vision":true,"documents":true}', '{"tokenParam":"max_tokens","maxOutputTokens":65536}', 1773000000000, 1773000000000),
  ('rt-chatgpt-2',  'srv-chatgpt',  'prov-agentrouter', 'deepseek-v4-flash',  2, 100, 1, '{"vision":false,"documents":true}', '{"tokenParam":"max_completion_tokens","maxOutputTokens":8192}', 1773000000000, 1773000000000),

  -- Gemini
  ('rt-gemini-1',   'srv-gemini',   'prov-codecraft',   'gemini-3.7-flash',   1, 100, 1, '{"vision":true,"documents":true}', '{"tokenParam":"max_tokens","maxOutputTokens":65536}', 1773000000000, 1773000000000),
  ('rt-gemini-2',   'srv-gemini',   'prov-agentrouter', 'deepseek-v4-flash',  2, 100, 1, '{"vision":false,"documents":true}', '{"tokenParam":"max_completion_tokens","maxOutputTokens":8192}', 1773000000000, 1773000000000),

  -- Claude
  ('rt-claude-1',   'srv-claude',   'prov-codecraft',   'claude-opus-5',      1, 100, 1, '{"vision":true,"documents":true}', '{"tokenParam":"max_tokens","maxOutputTokens":65536}', 1773000000000, 1773000000000),
  ('rt-claude-2',   'srv-claude',   'prov-agentrouter', 'deepseek-v4-flash',  2, 100, 1, '{"vision":false,"documents":true}', '{"tokenParam":"max_completion_tokens","maxOutputTokens":8192}', 1773000000000, 1773000000000),

  -- DeepSeek
  ('rt-deepseek-1', 'srv-deepseek', 'prov-agentrouter', 'deepseek-v4-flash',  1, 100, 1, '{"vision":false,"documents":true}', '{"tokenParam":"max_completion_tokens","maxOutputTokens":8192}', 1773000000000, 1773000000000),
  ('rt-deepseek-2', 'srv-deepseek', 'prov-codecraft',   'gpt-5.6-sol',        2, 100, 1, '{"vision":true,"documents":true}', '{"tokenParam":"max_tokens","maxOutputTokens":65536}', 1773000000000, 1773000000000),

  -- GLM
  ('rt-glm-1',      'srv-glm',      'prov-agentrouter', 'glm-5.3',            1, 100, 1, '{"vision":false,"documents":true}', '{"tokenParam":"max_completion_tokens","maxOutputTokens":8192}', 1773000000000, 1773000000000),
  ('rt-glm-2',      'srv-glm',      'prov-agentrouter', 'deepseek-v4-flash',  2, 100, 1, '{"vision":false,"documents":true}', '{"tokenParam":"max_completion_tokens","maxOutputTokens":8192}', 1773000000000, 1773000000000),

  -- Grok
  ('rt-grok-1',     'srv-grok',     'prov-codecraft',   'gpt-5.6-sol',        1, 100, 1, '{"vision":true,"documents":true}', '{"tokenParam":"max_tokens","maxOutputTokens":65536}', 1773000000000, 1773000000000),
  ('rt-grok-2',     'srv-grok',     'prov-agentrouter', 'deepseek-v4-flash',  2, 100, 1, '{"vision":false,"documents":true}', '{"tokenParam":"max_completion_tokens","maxOutputTokens":8192}', 1773000000000, 1773000000000);
