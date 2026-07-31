-- ChatDDB Phase 2, migration 0001: identity and audit.
--
-- Timestamps are INTEGER Unix milliseconds everywhere, matching the frontend's
-- `createdAt: number` so no date/string conversion is needed on either side.
--
-- `role` and `status` live only in this table. They are never carried in a
-- Firebase token and never trusted from a client -- every request re-reads them.

CREATE TABLE users (
  id              TEXT PRIMARY KEY,             -- uuid, our own identifier
  firebase_uid    TEXT NOT NULL UNIQUE,         -- from the verified token only
  email           TEXT NOT NULL,
  name            TEXT,
  profile_picture TEXT,
  role            TEXT NOT NULL DEFAULT 'user'   CHECK (role   IN ('user','admin')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at      INTEGER NOT NULL,
  last_login      INTEGER,
  login_count     INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_role_status ON users (role, status);
CREATE INDEX idx_users_created ON users (created_at DESC);

-- Audit trail. Deliberately not deletable through any API route; retention is
-- an operator command (`npm run db:prune`), never a UI button.
CREATE TABLE activity_logs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users (id) ON DELETE SET NULL,  -- NULL pre-auth
  action     TEXT NOT NULL,
  metadata   TEXT,          -- JSON; ids and counts, never message content
  ip_hash    TEXT,          -- truncated SHA-256(ip + IP_HASH_SALT); raw IP never stored
  user_agent TEXT,          -- truncated to 256 chars
  severity   TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','alert')),
  timestamp  INTEGER NOT NULL
);

CREATE INDEX idx_activity_user_ts ON activity_logs (user_id, timestamp DESC);
CREATE INDEX idx_activity_action_ts ON activity_logs (action, timestamp DESC);
CREATE INDEX idx_activity_severity_ts ON activity_logs (severity, timestamp DESC);
CREATE INDEX idx_activity_ts ON activity_logs (timestamp DESC);
