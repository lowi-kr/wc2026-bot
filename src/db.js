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
 * Get fixtures that are currently active: status is not yet finished.
 * Bounded to fixtures that kicked off within the last 6 hours as a safety
 * net, so a fixture stuck in a bad status (e.g. due to a bug or an ESPN
 * data gap) can't get polled forever — but the bound is generous enough
 * to comfortably cover regulation time + extra time + penalties + delays.
 *
 * Accepts an optional `filterFn` (fixture) => boolean. This is how the
 * group-stage country whitelist gets applied to live polling — without
 * it, every live/imminent match in D1 would be treated as active
 * regardless of whether it's a followed team, since this query has no
 * concept of the whitelist on its own. Pass `null`/omit to get everything
 * (used during knockout stage, when all matches are tracked).
 */
export async function getActiveFixtures(db, filterFn = null) {
  const now = Date.now();
  const safetyBoundStart = new Date(now - 6 * 60 * 60 * 1000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT * FROM fixtures
       WHERE kickoff_utc >= ?
         AND kickoff_utc <= ?
         AND status NOT IN ('FT', 'AET', 'PEN')
       ORDER BY kickoff_utc ASC`
    )
    .bind(safetyBoundStart, new Date(now).toISOString())
    .all();
  return filterFn ? results.filter(filterFn) : results;
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
