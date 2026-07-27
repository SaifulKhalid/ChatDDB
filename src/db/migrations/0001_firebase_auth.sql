-- Migration 0001: Add Firebase authentication support
-- Creates admin_emails and user_profiles tables for existing databases.
-- The user_id column on conversations was added via a manual ALTER TABLE
-- during the initial Firebase Auth deployment and is already present.
-- Fresh databases use schema.sql which includes all columns from the start.

-- Index for user-scoped conversation queries (safe: column already exists)
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);

-- Admin email allowlist for identifying admin users
CREATE TABLE IF NOT EXISTS admin_emails (
  email TEXT PRIMARY KEY,
  added_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- User profiles for tracking usage and sign-in activity
CREATE TABLE IF NOT EXISTS user_profiles (
  uid TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  is_disabled INTEGER NOT NULL DEFAULT 0,
  last_sign_in INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_email ON user_profiles(email);
