-- ChatDDB Phase 2, migration 0006: generated images.
--
-- Image generation stores its output in the same `files` table as an upload, so
-- signed view URLs, transcript rendering, orphan pruning, and the admin file
-- monitor all work on it with no changes. What the table could not previously
-- say is *where a file came from*, which matters in two places: the admin
-- inspector (a generated image was never uploaded by anyone, so "who uploaded
-- this" has no answer), and the UI (a generated image renders full-size, an
-- attachment renders as a 36px chip).
--
-- No CHECK on `origin`: SQLite's ALTER TABLE ADD COLUMN is restrictive about
-- constraints on added columns, and the only writers are createPending
-- ('upload', by default) and createGenerated ('generated').
--
-- `file_type` stays 'image' and needs no migration -- the existing
-- CHECK (file_type IN ('image','pdf')) already admits it.

ALTER TABLE files ADD COLUMN origin TEXT NOT NULL DEFAULT 'upload';

-- The prompt that produced the image, and the model that served it. Kept on the
-- file rather than only on the message because the file outlives the message on
-- `ON DELETE SET NULL`, and an image with no recoverable prompt is unattributable.
ALTER TABLE files ADD COLUMN gen_prompt TEXT;
ALTER TABLE files ADD COLUMN gen_model TEXT;

CREATE INDEX idx_files_origin ON files (origin, created_at DESC);
