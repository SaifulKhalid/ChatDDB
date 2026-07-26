-- D1 schema for PrototypeChatBot
-- Conversations (chat threads) and messages (with optional attachments stored in R2).

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New chat',
  model TEXT NOT NULL DEFAULT 'groq:llama-3.3-70b-versatile',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '[]', -- JSON array of {id, name, type, size, r2Key, kind}
  model TEXT, -- which model generated an assistant message
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at ASC);

-- Document chunks for extracted PDF text, enabling chunk-based retrieval
-- instead of sending the full document every time.
CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_doc_chunks_attachment ON document_chunks(attachment_id, chunk_index ASC);

-- Admin-defined models (editable from the settings dashboard)
-- These are merged with hardcoded defaults at runtime.
CREATE TABLE IF NOT EXISTS admin_models (
  row_id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('groq', 'gemini', 'agentrouter', 'openrouter', 'workers-ai')),
  supports_vision INTEGER NOT NULL DEFAULT 0,
  supports_streaming INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_admin_models_provider ON admin_models(provider);