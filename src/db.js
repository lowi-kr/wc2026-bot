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
 *
 * An optional filterFn can be passed to additionally restrict the result
 * (e.g. to followed countries during the group stage). It receives each
 * fixture row and should return true to keep it.
 */
export async function getActiveFixtures(db, filterFn) {
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
  return typeof filterFn === "function" ? results.filter(filterFn) : results;
}

/**
 * Get fixtures that finished recently (in the last `withinMinutes`) and are
 * still flagged as needing a final-stats retry (see markStatsPending /
 * clearStatsPending below). Used by the minute-poll cron to follow up with
 * a FINAL STATS message if ESPN's boxscore wasn't ready at full time.
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

/**
 * Mark fixture(s) as included in a schedule post.
 */
export async function markSchedulePosted(db, fixtureId) {
  await db
    .prepare(`UPDATE fixtures SET posted_schedule = 1 WHERE id = ?`)
    .bind(fixtureId)
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

// ─── Event Log (used by the admin dashboard's activity feed) ─────────────────

/**
 * Insert a row into event_log. Matches the existing schema used by the
 * admin dashboard (admin.js): id, ts, level, message.
 */
export async function writeEventLog(db, level, message) {
  await db
    .prepare(`INSERT INTO event_log (ts, level, message) VALUES (?, ?, ?)`)
    .bind(new Date().toISOString(), level, message)
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
