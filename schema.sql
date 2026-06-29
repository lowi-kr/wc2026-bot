-- FIFA World Cup 2026 Bot - D1 Schema
-- Run via: wrangler d1 execute wc2026 --file=schema.sql
-- NOTE: if pasting into the Cloudflare D1 Console UI instead of using
-- wrangler, paste ONE CREATE TABLE statement at a time. The Console's
-- input box can mangle line breaks on paste, and since "--" starts a
-- SQL line comment, a lost newline can comment out the rest of a
-- statement (including its closing parenthesis), causing an
-- "incomplete input" SQLITE_ERROR. Keeping comments only on their own
-- lines above each statement (not trailing on the same line as SQL)
-- avoids this.
--👇👇 paste from here 👇👇

CREATE TABLE IF NOT EXISTS fixtures (
  id INTEGER PRIMARY KEY,
  home TEXT NOT NULL,
  away TEXT NOT NULL,
  kickoff_utc TEXT NOT NULL,
  round TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NS',
  posted_schedule INTEGER NOT NULL DEFAULT 0,
  stats_pending INTEGER NOT NULL DEFAULT 0,
  final_home_score INTEGER,
  final_away_score INTEGER
);

CREATE TABLE IF NOT EXISTS seen_events (
  fixture_id INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  PRIMARY KEY (fixture_id, event_key)
);

CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
