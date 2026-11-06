-- ChatDDB Phase 3, migration 0009: guest mode.
--
-- Additive ALTER only (no table rebuild): users has foreign key cascades from
-- chat_sessions, chat_messages, and files, which SQLite would drop on a rebuild.
--
-- Guests receive a synthetic unique email (guest-<user.id>@guest.invalid) to satisfy
-- the existing NOT NULL and unique index on email.

ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_users_guest ON users (is_guest);
