-- ChatDDB Phase 2, migration 0004: rate limiting.
--
-- Cloudflare's `ratelimits` binding is GA but counts per-location with a fixed
-- 10 s or 60 s period -- no use for "300 messages per day per user". So:
-- counters in D1, keyed by an *absolute* window start rather than elapsed time.
--
-- The absolute bucket matters. Workers pin `Date.now()` between I/O, so
-- measuring "how long ago did this window open" inside one request is
-- unreliable; flooring the clock into a bucket is not.

CREATE TABLE rate_counters (
  subject      TEXT NOT NULL,   -- 'user:<id>' | 'ip:<hash>'
  window_kind  TEXT NOT NULL CHECK (window_kind IN ('minute','day')),
  action       TEXT NOT NULL,   -- 'chat' | 'upload' | 'auth' | 'admin'
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, window_kind, action, window_start)
);

-- Lets `npm run db:prune` drop expired buckets without a table scan.
CREATE INDEX idx_rate_window ON rate_counters (window_start);
