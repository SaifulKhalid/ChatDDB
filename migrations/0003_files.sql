-- ChatDDB Phase 2, migration 0003: uploads.
--
-- Extracted PDF text goes to R2, not here: a 25 MB PDF can yield megabytes of
-- text and D1 responses are capped around 1 MB. D1 keeps a ~2 KB preview so the
-- admin file list renders with no R2 reads.

CREATE TABLE files (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_id             TEXT REFERENCES chat_sessions (id) ON DELETE SET NULL,
  -- Nullable because a file is uploaded *before* the message carrying it
  -- exists. Orphans (still NULL after 24 h) are pruned by `npm run db:prune`.
  message_id             TEXT REFERENCES chat_messages (id) ON DELETE SET NULL,
  filename               TEXT NOT NULL,   -- sanitised storage name
  original_filename      TEXT NOT NULL,   -- as uploaded, display only
  file_type              TEXT NOT NULL CHECK (file_type IN ('image','pdf')),
  mime_type              TEXT NOT NULL,   -- sniffed from magic bytes, not client-declared
  file_size              INTEGER NOT NULL,
  r2_key                 TEXT NOT NULL UNIQUE,
  sha256                 TEXT,
  upload_status          TEXT NOT NULL DEFAULT 'pending'
                           CHECK (upload_status IN ('pending','stored','failed')),
  processing_status      TEXT NOT NULL DEFAULT 'none'
                           CHECK (processing_status IN ('none','pending','done','failed','unsupported')),
  extracted_text_key     TEXT,            -- R2 key of the full extracted text
  extracted_text_preview TEXT,            -- first ~2 KB, for admin display
  extracted_chars        INTEGER,
  extracted_pages        INTEGER,
  -- 'client' text is user-supplied (Free-plan pdf.js path) and is labelled as
  -- such in the admin UI; the original PDF stays the authority for re-extraction.
  extraction_source      TEXT CHECK (extraction_source IN ('worker','client')),
  created_at             INTEGER NOT NULL
);

CREATE INDEX idx_files_user_created ON files (user_id, created_at DESC);
CREATE INDEX idx_files_message ON files (message_id);
CREATE INDEX idx_files_session ON files (session_id);
CREATE INDEX idx_files_status ON files (processing_status);
