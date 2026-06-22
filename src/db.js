/**
 * db.js — All D1 database interactions
 */

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Upsert a list of fixture objects into D1.
 * Skips fixtures that already exist (by id).
 */
export async function upsertFixtures(db, fixtures) {
  for (const f of fixtures) {
    await db
      .prepare(
        `INSERT INTO fixtures (id, home, away, kickoff_utc, round, stage, status)
         VALUES (?, ?, ?, ?, ?, ?, 'NS')
         ON CONFLICT(id) DO NOTHING`
      )
      .bind(f.id, f.home, f.away, f.kickoff_utc, f.round, f.stage)
      .run();
  }
}

/**
 * Get all fixtures on a given UTC date string (YYYY-MM-DD).
 */
export async function getFixturesByDate(db, date) {
  const { results } = await db
    .prepare(`SELECT * FROM fixtures WHERE kickoff_utc LIKE ? ORDER BY kickoff_utc ASC`)
    .bind(`${date}%`)
    .all();
  return results;
}

/**
 * Get fixtures that are currently active:
 * kicked off in the last 130 minutes and not yet marked FT/AET/PEN.
 */
export async function getActiveFixtures(db) {
  const now = Date.now();
  const windowStart = new Date(now - 130 * 60 * 1000).toISOString();
  const windowEnd = new Date(now).toISOString();
  const { results } = await db
    .prepare(
      `SELECT * FROM fixtures
       WHERE kickoff_utc >= ?
         AND kickoff_utc <= ?
         AND status NOT IN ('FT', 'AET', 'PEN')
       ORDER BY kickoff_utc ASC`
    )
    .bind(windowStart, windowEnd)
    .all();
  return results;
}

/**
 * Update the status of a fixture.
 */
export async function updateFixtureStatus(db, fixtureId, status) {
  await db
    .prepare(`UPDATE fixtures SET status = ? WHERE id = ?`)
    .bind(status, fixtureId)
    .run();
}

/**
 * Mark fixture(s) as included in a schedule post.
 */
export async function markSchedulePosted(db, fixtureId) {
  await db
    .prepare(`UPDATE fixtures SET posted_schedule = 1 WHERE id = ?`)
    .bind(fixtureId)
    .run();
}

/**
 * Get a single fixture by id. Used by the admin dashboard.
 */
export async function getFixtureById(db, fixtureId) {
  return db
    .prepare(`SELECT * FROM fixtures WHERE id = ?`)
    .bind(fixtureId)
    .first();
}

// ─── Seen Events ──────────────────────────────────────────────────────────────

/**
 * Get all seen event keys for a fixture.
 */
export async function getSeenEvents(db, fixtureId) {
  const { results } = await db
    .prepare(`SELECT event_key FROM seen_events WHERE fixture_id = ?`)
    .bind(fixtureId)
    .all();
  return new Set(results.map((r) => r.event_key));
}

/**
 * Insert a seen event key (ignore if already exists).
 */
export async function insertSeenEvent(db, fixtureId, eventKey) {
  await db
    .prepare(
      `INSERT INTO seen_events (fixture_id, event_key) VALUES (?, ?)
       ON CONFLICT DO NOTHING`
    )
    .bind(fixtureId, eventKey)
    .run();
}

// ─── Bot State ────────────────────────────────────────────────────────────────

export async function getState(db, key) {
  const row = await db
    .prepare(`SELECT value FROM bot_state WHERE key = ?`)
    .bind(key)
    .first();
  return row ? row.value : null;
}

export async function setState(db, key, value) {
  await db
    .prepare(
      `INSERT INTO bot_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(key, value)
    .run();
}

// ─── Event Log ────────────────────────────────────────────────────────────────
// A simple self-written activity log so the admin dashboard has something
// to show. NOT a replacement for Cloudflare's real logs (still use
// `wrangler tail` or the dashboard Logs tab for deep debugging) — this is
// just a rolling history of "what did the bot decide and do."

/**
 * Write one line to the event log. Never throws — logging should never
 * be allowed to break the calling code path.
 */
export async function logEvent(db, level, message) {
  try {
    await db
      .prepare(`INSERT INTO event_log (ts, level, message) VALUES (?, ?, ?)`)
      .bind(new Date().toISOString(), level, message)
      .run();
  } catch (err) {
    // Swallow — logging failures shouldn't take down the bot.
    console.error("logEvent failed:", err);
  }
}

/**
 * Get the most recent N log lines, newest first.
 */
export async function getRecentLogs(db, limit = 100) {
  const { results } = await db
    .prepare(`SELECT id, ts, level, message FROM event_log ORDER BY id DESC LIMIT ?`)
    .bind(limit)
    .all();
  return results;
}

/**
 * Trim the log table so it doesn't grow forever. Keeps the most recent
 * `keep` rows. Cheap to call opportunistically (e.g. once a day).
 */
export async function trimEventLog(db, keep = 500) {
  await db
    .prepare(
      `DELETE FROM event_log WHERE id NOT IN (
         SELECT id FROM event_log ORDER BY id DESC LIMIT ?
       )`
    )
    .bind(keep)
    .run();
}