-- BanyanCode install telemetry — D1 schema (specs/banyancode/install-telemetry.md)
--
-- install_id is NOT the primary key. The unique index on (install_id, event_type)
-- enforces one row per (install, event type) with latest-timestamp semantics:
-- heartbeats overwrite the previous heartbeat row via INSERT ... ON CONFLICT DO UPDATE.
--
-- event_id is a per-row identifier only (worker generates a fresh UUID per insert);
-- on conflict it is left untouched because the row is updated in place.
--
-- 365-day retention: purge rows older than 365 days with a scheduled cron or
-- `wrangler d1 execute` (see README.md).

CREATE TABLE IF NOT EXISTS install_events (
  event_id TEXT PRIMARY KEY,
  install_id TEXT NOT NULL,
  event_type TEXT NOT NULL,          -- 'first_run' | 'heartbeat'
  timestamp INTEGER NOT NULL,        -- epoch milliseconds (Date.now())
  version TEXT, channel TEXT,
  os TEXT, arch TEXT,
  install_method TEXT,
  ci INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_install_event_type ON install_events (install_id, event_type);
