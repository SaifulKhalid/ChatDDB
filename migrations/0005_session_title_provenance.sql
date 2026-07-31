-- ChatDDB migration 0005: where a session title came from.
--
-- Auto-naming needs to know whether a title is still up for grabs. The old test
-- was `WHERE title = 'New chat'`, which breaks the moment a user renames a chat
-- to that string by hand, and offers nowhere to record "the model named this".
--
-- Backfill mirrors the old guard exactly rather than approximating it: rows the
-- literal-string test would have retitled become 'placeholder' and stay
-- eligible; every other existing title is treated as the user's own choice and
-- frozen. NOT NULL is safe here because the CASE covers every row.

ALTER TABLE chat_sessions
  ADD COLUMN title_source TEXT NOT NULL DEFAULT 'manual'
  CHECK (title_source IN ('placeholder','auto','manual'));

UPDATE chat_sessions
   SET title_source = CASE WHEN title = 'New chat' THEN 'placeholder' ELSE 'manual' END;
