/**
 * db.js — All D1 database interactions
 */

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Upsert a list of fixture objects into D1.
 * Only overwrites existing rows if their status is still 'NS', so we never
 * clobber live-tracking state (status, stats_pending, final scores) with a
 * stale re-fetch.
 */
export async function upsertFixtures(db, fixtures) {
  for (const f of fixtures) {
    await db
      .prepare(
        `INSERT INTO fixtures (id, home, away, kickoff_utc, round, stage, status)
         VALUES (?, ?, ?, ?, ?, ?, 'NS')
         ON CONFLICT(id) DO UPDATE SET
           home        = excluded.home,
           away        = excluded.away,
           kickoff_utc = excluded.kickoff_utc,
           round       = excluded.round,
           stage       = excluded.stage
         WHERE fixtures.status = 'NS'`
      )
      .bind(f.id, f.home, f.away, f.kickoff_utc, f.round, f.stage)
      .run();
  }
}

/**
 * Get all fixtures on a given UTC date string (YYYY-MM-DD).
 * This is a D1 query against kickoff_utc — always UTC-accurate, unlike
 * ESPN's own dates= scoreboard parameter (see api.js header comment).
 */
export async function getFixturesByDate(db, date) {
  const { results } = await db
    .prepare(`SELECT * FROM fixtures WHERE kickoff_utc LIKE ? ORDER BY kickoff_utc ASC`)
    .bind(`${date}%`)
    .all();
  return results;
}

/**
 * Get fixtures that are currently active: kicking off within `lookaheadMinutes`,
 * or kicked off within the last `lookbackHours` and not yet marked FT/AET/PEN.
 */
export async function getActiveFixtures(db, lookaheadMinutes = 70, lookbackHours = 4) {
  const now        = Date.now();
  const windowEnd   = new Date(now + lookaheadMinutes * 60 * 1000).toISOString();
  const windowStart = new Date(now - lookbackHours * 60 * 60 * 1000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT * FROM fixtures
       WHERE kickoff_utc <= ?
         AND kickoff_utc >= ?
         AND status NOT IN ('FT', 'AET', 'PEN')
       ORDER BY kickoff_utc ASC`
    )
    .bind(windowEnd, windowStart)
    .all();
  return results;
}

/**
 * Get finished fixtures still waiting on final stats (stats_pending = 1).
 *
 * NOTE: the fixtures table has no finished_at / stats_pending_since column,
 * so this is necessarily approximated from kickoff_utc. A match can run
 * 90 minutes (regulation) up to ~2.5 hours (extra time + penalties) after
 * kickoff before reaching FT, plus however long ESPN takes to publish full
 * boxscore stats after that. 300 minutes (5 hours) comfortably covers that
 * whole span while still being bounded (never grows unbounded — see the
 * project's "no unbounded active/pending queries" principle). The previous
 * 15-minute default was a bug: no real match can finish within 15 minutes
 * of its own kickoff, so this query effectively never matched anything.
 */
export async function getFixturesPendingStats(db, withinMinutes = 300) {
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

export async function markStatsPending(db, fixtureId) {
  await db
    .prepare(`UPDATE fixtures SET stats_pending = 1 WHERE id = ?`)
    .bind(fixtureId)
    .run();
}

export async function clearStatsPending(db, fixtureId) {
  await db
    .prepare(`UPDATE fixtures SET stats_pending = 0 WHERE id = ?`)
    .bind(fixtureId)
    .run();
}

export async function setFinalScore(db, fixtureId, homeScore, awayScore) {
  await db
    .prepare(`UPDATE fixtures SET final_home_score = ?, final_away_score = ? WHERE id = ?`)
    .bind(homeScore, awayScore, fixtureId)
    .run();
}

/**
 * Fully reset a fixture back to a clean, untracked state — for manual
 * retesting via the dashboard or `?action=reset_fixture`. This clears every
 * piece of per-fixture state we track, not just `status`:
 *   - fixtures.status        → 'NS'
 *   - fixtures.stats_pending → 0
 *   - fixtures.final_home_score / final_away_score → NULL
 *   - seen_events            → deleted (goal dedup keys)
 *   - bot_state ft_stats_retries_{id} → deleted (otherwise a fixture that
 *     already exhausted its 5 retry attempts would get zero retries after
 *     reset, since the old count would still be sitting there)
 *   - bot_state extra_phase_{id}      → deleted (ET/shootout phase tracker)
 *   - bot_state stats_shape_{id}, goal_play_shape_v2_{id},
 *     extra_time_shape_{id} → deleted (one-time diagnostic shape-capture
 *     flags; a genuine retest should be able to recapture these)
 * Both reset entry points (dashboard and ?action=reset_fixture) should call
 * this instead of hand-rolling their own partial reset, so they can't drift
 * out of sync with each other again.
 */
export async function resetFixtureState(db, fixtureId) {
  await db.prepare("DELETE FROM seen_events WHERE fixture_id = ?").bind(fixtureId).run();
  await db
    .prepare(
      `UPDATE fixtures
       SET status = 'NS', stats_pending = 0, final_home_score = NULL, final_away_score = NULL
       WHERE id = ?`
    )
    .bind(fixtureId)
    .run();
  await db
    .prepare(`DELETE FROM bot_state WHERE key IN (?, ?, ?, ?, ?)`)
    .bind(
      `ft_stats_retries_${fixtureId}`,
      `extra_phase_${fixtureId}`,
      `stats_shape_${fixtureId}`,
      `goal_play_shape_v2_${fixtureId}`,
      `extra_time_shape_${fixtureId}`
    )
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

export async function findFixtureByTeam(db, term) {
  const row = await db
    .prepare(
      `SELECT * FROM fixtures
       WHERE home LIKE ? OR away LIKE ?
       ORDER BY
         CASE WHEN status NOT IN ('FT','AET','PEN') THEN 0 ELSE 1 END,
         kickoff_utc DESC
       LIMIT 1`
    )
    .bind(`%${term}%`, `%${term}%`)
    .first();
  return row || null;
}

export async function getCurrentlyLiveFixtures(db) {
  const { results } = await db
    .prepare(`SELECT * FROM fixtures WHERE status NOT IN ('NS','FT','AET','PEN') ORDER BY kickoff_utc ASC`)
    .all();
  return results;
}

export async function getMostRecentFinishedFixture(db) {
  const row = await db
    .prepare(`SELECT * FROM fixtures WHERE status IN ('FT','AET','PEN') ORDER BY kickoff_utc DESC LIMIT 1`)
    .first();
  return row || null;
}

export async function getUpcomingFixtures(db, term, limit = 5) {
  if (term) {
    const { results } = await db
      .prepare(
        `SELECT * FROM fixtures
         WHERE status = 'NS' AND (home LIKE ? OR away LIKE ?)
         ORDER BY kickoff_utc ASC LIMIT ?`
      )
      .bind(`%${term}%`, `%${term}%`, limit)
      .all();
    return results;
  }
  const { results } = await db
    .prepare(`SELECT * FROM fixtures WHERE status = 'NS' ORDER BY kickoff_utc ASC LIMIT ?`)
    .bind(limit)
    .all();
  return results;
}

export async function getFixtureStatusCounts(db) {
  const { results } = await db
    .prepare(`SELECT status, COUNT(*) as cnt FROM fixtures GROUP BY status ORDER BY cnt DESC`)
    .all();
  return results;
}

export async function getStuckFixtures(db, lookbackHours = 4) {
  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT * FROM fixtures
       WHERE status NOT IN ('FT','AET','PEN')
         AND kickoff_utc < ?
       ORDER BY kickoff_utc ASC`
    )
    .bind(cutoff)
    .all();
  return results;
}

export async function getFollowedOverrides(db) {
  const raw = await getState(db, "followed_overrides");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function addFollowedOverride(db, team) {
  const current = await getFollowedOverrides(db);
  const lower = team.toLowerCase();
  if (!current.some((t) => t.toLowerCase() === lower)) current.push(team);
  await setState(db, "followed_overrides", JSON.stringify(current));
  return current;
}

export async function removeFollowedOverride(db, team) {
  const current = await getFollowedOverrides(db);
  const lower = team.toLowerCase();
  const next = current.filter((t) => t.toLowerCase() !== lower);
  await setState(db, "followed_overrides", JSON.stringify(next));
  return next;
}

// ─── Seen Events ──────────────────────────────────────────────────────────────

export async function getSeenEvents(db, fixtureId) {
  const { results } = await db
    .prepare(`SELECT event_key FROM seen_events WHERE fixture_id = ?`)
    .bind(fixtureId)
    .all();
  return new Set(results.map((r) => r.event_key));
}

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

export async function deleteState(db, key) {
  await db.prepare(`DELETE FROM bot_state WHERE key = ?`).bind(key).run();
}

// ─── Event Log ────────────────────────────────────────────────────────────────

export async function logEvent(db, level, message) {
  try {
    await db
      .prepare(`INSERT INTO event_log (ts, level, message) VALUES (?, ?, ?)`)
      .bind(new Date().toISOString(), level, message)
      .run();
  } catch (err) {
    console.error("logEvent failed:", err);
  }
}

export async function getRecentLogs(db, limit = 100) {
  const { results } = await db
    .prepare(`SELECT id, ts, level, message FROM event_log ORDER BY id DESC LIMIT ?`)
    .bind(limit)
    .all();
  return results;
}

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
