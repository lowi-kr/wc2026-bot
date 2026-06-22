-- FIFA World Cup 2026 Bot — D1 Schema
-- Run via: wrangler d1 execute wc2026 --file=schema.sql
-- (or paste into the D1 Console tab in the Cloudflare dashboard)

CREATE TABLE IF NOT EXISTS fixtures (
  id          INTEGER PRIMARY KEY,   -- API-Football fixture ID
  home        TEXT    NOT NULL,
  away        TEXT    NOT NULL,
  kickoff_utc TEXT    NOT NULL,      -- ISO 8601 e.g. "2026-06-14T18:00:00+00:00"
  round       TEXT    NOT NULL,
  stage       TEXT    NOT NULL,      -- "group" | "knockout"
  status      TEXT    NOT NULL DEFAULT 'NS', -- NS, 1H, HT, 2H, ET, P, FT, AET, PEN
  posted_schedule INTEGER NOT NULL DEFAULT 0  -- 1 once included in a schedule post
);

CREATE TABLE IF NOT EXISTS seen_events (
  fixture_id  INTEGER NOT NULL,
  event_key   TEXT    NOT NULL,      -- "{elapsed}{extra}_{type}_{player_id}"
  PRIMARY KEY (fixture_id, event_key)
);

CREATE TABLE IF NOT EXISTS bot_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Rows used:
--   group_schedule_posted  → "1" once full group stage schedule has been posted
--   daily_schedule_{date}  → "1" once tomorrow's schedule posted for that date

-- NEW: event_log — lightweight activity log the bot writes to itself,
-- so the admin dashboard has something to show without needing access
-- to Cloudflare's real invocation logs (which aren't readable via API
-- from inside the Worker).
CREATE TABLE IF NOT EXISTS event_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT    NOT NULL,        -- ISO 8601 timestamp
  level     TEXT    NOT NULL,        -- "info" | "warn" | "error"
  message   TEXT    NOT NULL
);