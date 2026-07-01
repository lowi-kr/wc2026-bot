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
 * Get fixtures that are currently active OR about to start:
 *   - kicked off in the last 130 minutes and not yet marked FT/AET/PEN, OR
 *   - kicking off within the next `lookaheadMinutes` minutes.
 *
 * The lookahead half matters: without it, a fixture that hasn't kicked off
 * yet is invisible to this query, which means the minute-poll cron's "is
 * everything done, can I go back to sleep" check (see runMinutePoll in
 * index.js) sees an empty result and concludes there's nothing to do —
 * even when a kickoff the hourly check correctly flagged as imminent is
 * only minutes away. That mismatch caused the bot to clear game_imminent
 * one minute after setting it and sleep right through an actual kickoff.
 * Defaults to 70 minutes to match runHourlyCheck's own lookahead window,
 * so the two checks can never disagree about what counts as "imminent".
 */
export async function getActiveFixtures(db, lookaheadMinutes = 70) {
  const now = Date.now();
  const windowStart = new Date(now - 130 * 60 * 1000).toISOString();
  const windowEnd = new Date(now + lookaheadMinutes * 60 * 1000).toISOString();
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
 * Get fixtures that finished recently and are still flagged as needing a
 * final-stats retry (see markStatsPending / clearStatsPending below). Used
 * by the minute-poll cron to follow up with a FINAL STATS message if
 * ESPN's boxscore wasn't ready at full time.
 */
export async function getFixturesPendingStats(db, withinMinutes = 15) {
  const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT * FROM fixtures
       WHERE status IN ('FT', 'AET', 'PEN')
         AND stats_pending = 1
         AND kickoff_utc >= ?
       ORDER BY kickoff_utc ASC`
    )
    .bind(cutoff)
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

/**
 * Mark a fixture as needing a final-stats retry (called when full-time
 * stats came back empty at the moment FULL TIME was posted).
 */
export async function markStatsPending(db, fixtureId) {
  await db
    .prepare(`UPDATE fixtures SET stats_pending = 1 WHERE id = ?`)
    .bind(fixtureId)
    .run();
}

/**
 * Clear the final-stats-pending flag (called once a retry succeeds, or once
 * we give up after enough attempts).
 */
export async function clearStatsPending(db, fixtureId) {
  await db
    .prepare(`UPDATE fixtures SET stats_pending = 0 WHERE id = ?`)
    .bind(fixtureId)
    .run();
}

/**
 * Store the final score on a fixture at full time, so a later stats retry
 * (which doesn't have the live scoreboard response handy) can still build
 * a correctly-scored FINAL STATS follow-up message.
 */
export async function setFinalScore(db, fixtureId, homeScore, awayScore) {
  await db
    .prepare(`UPDATE fixtures SET final_home_score = ?, final_away_score = ? WHERE id = ?`)
    .bind(homeScore, awayScore, fixtureId)
    .run();
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