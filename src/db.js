/**
 * db.js — All D1 database interactions
 */

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Upsert a list of fixture objects into D1.
 *
 * If a fixture already exists AND hasn't started yet (status='NS'), refresh
 * its home/away/kickoff_utc/round/stage from ESPN. ESPN sometimes corrects
 * scheduled kickoff times after our initial fetch (we saw a 1-hour drift on
 * a real fixture); previously we used ON CONFLICT DO NOTHING, which meant a
 * stale kickoff_utc could persist forever, throwing off any time-based
 * calculation against it. Once a fixture has actually started (status is no
 * longer 'NS'), we never touch it here — only the live-polling code updates
 * an in-progress/finished fixture's row.
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
 *   - not yet marked FT/AET/PEN (i.e. still genuinely in progress, however
 *     long that takes — extra time, stoppage, penalties, all of it), OR
 *   - kicking off within the next `lookaheadMinutes` minutes.
 *
 * There is deliberately NO trailing wall-clock cutoff here. We used to filter
 * out anything that kicked off more than 130 (then 200) minutes ago, which
 * cut off real matches mid-second-half and caused missed goals and missed
 * full-time posts. `status NOT IN ('FT','AET','PEN')` is the only thing that
 * should decide whether a fixture is still active — that status is refreshed
 * from ESPN every minute this cron runs, so it can't go stale the way a
 * cached kickoff time can.
 *
 * The lookahead half still matters: without it, a fixture that hasn't kicked
 * off yet is invisible to this query, which means the minute-poll cron's "is
 * everything done, can I go back to sleep" check (see runMinutePoll in
 * index.js) sees an empty result and concludes there's nothing to do — even
 * when a kickoff the hourly check correctly flagged as imminent is only
 * minutes away. That mismatch caused the bot to clear game_imminent one
 * minute after setting it and sleep right through an actual kickoff.
 * Defaults to 70 minutes to match runHourlyCheck's own lookahead window, so
 * the two checks can never disagree about what counts as "imminent".
 */
export async function getActiveFixtures(db, lookaheadMinutes = 70, lookbackHours = 4) {
  const now = Date.now();
  const windowEnd = new Date(now + lookaheadMinutes * 60 * 1000).toISOString();
  // Lower bound is a safety net, not a correctness mechanism: a match stuck at
  // LIVE/HT from days or weeks ago (e.g. a reconciliation backlog) should never
  // be re-included here. 4 hours generously covers 90 min regulation + HT + ET
  // + penalties + buffer. Without this bound, every unreconciled stale fixture
  // gets re-checked on every minute-poll, burning through the Workers
  // per-invocation subrequest limit and starving the actual live matches that
  // sort after them by kickoff_utc — this is what silently dropped tonight's
  // France vs Morocco kickoff message.
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

/**
 * Find a fixture by a team-name search term (case-insensitive substring
 * match against home or away). Prefers an in-progress match over a
 * finished one, and the most recent kickoff among ties. Used by the
 * "stats <team>" / "live <team>" / "goals <team>" chat commands.
 */
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

/**
 * Get fixtures that are genuinely in progress right now (excludes NS —
 * "kicking off soon" doesn't count as live for chat-command purposes).
 */
export async function getCurrentlyLiveFixtures(db) {
  const { results } = await db
    .prepare(`SELECT * FROM fixtures WHERE status NOT IN ('NS','FT','AET','PEN') ORDER BY kickoff_utc ASC`)
    .all();
  return results;
}

/**
 * Get the most recently finished fixture (by kickoff time), if any.
 * Used as the fallback target for "stats"/"goals"/"live" when nothing is
 * live right now.
 */
export async function getMostRecentFinishedFixture(db) {
  const row = await db
    .prepare(`SELECT * FROM fixtures WHERE status IN ('FT','AET','PEN') ORDER BY kickoff_utc DESC LIMIT 1`)
    .first();
  return row || null;
}

/**
 * Get upcoming (not-yet-started) fixtures soonest-first, optionally filtered
 * to ones involving a team. Used by the "next"/"next <team>" chat command.
 */
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

/**
 * Count of fixtures per status — used by "!admin status" for a quick health
 * snapshot without needing the admin dashboard.
 */
export async function getFixtureStatusCounts(db) {
  const { results } = await db
    .prepare(`SELECT status, COUNT(*) as cnt FROM fixtures GROUP BY status ORDER BY cnt DESC`)
    .all();
  return results;
}

/**
 * Fixtures that look stuck: still not FT/AET/PEN, but kicked off longer ago
 * than any real match (including ET + penalties) could still be running.
 * Mirrors getActiveFixtures' own lookback window so "stuck" here means
 * exactly "would no longer be picked up by the live poller." Used by
 * "!admin reconcile" to find candidates to re-check against ESPN.
 */
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

// ─── Dynamic Follow Overrides ─────────────────────────────────────────────────
// Layered on top of the static countries.js list so teams can be added or
// removed at runtime (via "!admin follow <team>" / "!admin unfollow <team>")
// without a code edit + redeploy. Stored as a single JSON array under one
// bot_state row.

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
