-- ChatDDB Phase 2, migration 0002: conversations.
--
-- `message_count` on chat_sessions and `user_id` on chat_messages are both
-- deliberate denormalisations. The sidebar and the admin user table each list
-- sessions, and a COUNT(*) per row would multiply D1 row reads against a
-- Free-tier budget; the counter is maintained in the same batch as the insert.

CREATE TABLE chat_sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  model_used    TEXT,                             -- last model used in this session
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER                           -- soft delete; see PRIVACY.md
);

CREATE INDEX idx_sessions_user_updated ON chat_sessions (user_id, updated_at DESC);
CREATE INDEX idx_sessions_updated ON chat_sessions (updated_at DESC);

CREATE TABLE chat_messages (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
  -- Duplicates chat_sessions.user_id on purpose: "everything this user said
  -- last week" and per-user quota counting would otherwise join on every row.
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  message_content   TEXT NOT NULL,
  model_provider    TEXT,                         -- 'agentrouter'
  model_used        TEXT,                         -- 'gpt-5.6-sol'
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  -- 'upstream' when AgentRouter reported usage, 'estimate' when we approximated
  -- it from character count. The admin UI labels estimates rather than
  -- presenting them as billing truth.
  token_source      TEXT CHECK (token_source IN ('upstream','estimate')),
  attachment_count  INTEGER NOT NULL DEFAULT 0,
  finish_reason     TEXT,                         -- incl. 'aborted'
  error             TEXT,                         -- set when generation failed
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_messages_session_created ON chat_messages (session_id, created_at);
CREATE INDEX idx_messages_user_created ON chat_messages (user_id, created_at DESC);
CREATE INDEX idx_messages_created ON chat_messages (created_at DESC);
