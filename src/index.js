/**
 * index.js — FIFA World Cup 2026 GroupMe Bot
 * Cloudflare Workers entry point
 *
 * Data source: ESPN unofficial API (no key required)
 *
 * Polling strategy (3-tier):
 *   Midnight UTC  — checks D1 for games today, sets KV flag "games_today"
 *   Every hour    — only if games_today=true, checks for imminent game, sets "game_imminent"
 *   Every minute  — only if game_imminent=true, runs live polling
 */

import { fetchFixturesInRange, fetchFixturesByDate, fetchLiveFixtures, fetchEvents, fetchStats, ESPN_STATUS } from "./api.js";
import { postToGroupMe } from "./groupme.js";
import { formatGroupStageSchedule, formatDailySchedule, formatKickoff, formatHalfTime, formatFullTime, formatFinalStatsFollowUp, formatEvent, formatGenericGoal } from "./formatter.js";
import {
  upsertFixtures, getFixturesByDate, getActiveFixtures, getFixturesPendingStats,
  updateFixtureStatus, markStatsPending, clearStatsPending, setFinalScore,
  getSeenEvents, insertSeenEvent, getState, setState, writeEventLog,
} from "./db.js";

// Try to import country filter — if the file is deleted, no filter is applied.
let FOLLOWED_COUNTRIES = null;
try {
  const mod = await import("./countries.js");
  FOLLOWED_COUNTRIES = mod.FOLLOWED_COUNTRIES;
} catch {
  // countries.js deleted — follow all teams
}

// ─── World Cup 2026 Dates ─────────────────────────────────────────────────────
const GROUP_STAGE_START = "2026-06-11";
const GROUP_STAGE_END   = "2026-06-27";

// KV keys
const KV_GAMES_TODAY    = "games_today";      // "1" or "0"
const KV_GAME_IMMINENT  = "game_imminent";    // "1" or "0"

// How many times to retry fetching full-time stats if they weren't ready
// at the moment FULL TIME was posted, before giving up silently.
const FT_STATS_MAX_RETRIES = 5;

// ─── Cron Entry Point ─────────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron;

    if (cron === "0 0 * * *") {
      // Midnight UTC — check if there are games today
      ctx.waitUntil(runMidnightCheck(env));
    } else if (cron === "0 8 * * *") {
      // 8AM UTC — post tomorrow's knockout schedule + fetch fixtures into D1
      ctx.waitUntil(runDailyJob(env));
    } else if (cron === "0 * * * *") {
      // Every hour — check if a game is starting within the next 60 minutes
      ctx.waitUntil(runHourlyCheck(env));
    } else if (cron === "* * * * *") {
      // Every minute — only runs live polling if game_imminent is set
      ctx.waitUntil(runMinutePoll(env));
    }
  },

  async fetch(request, env) {
    const url    = new URL(request.url);
    const action = url.searchParams.get("action");

    if (action === "init") {
      await initGroupStage(env);
      return new Response("Group stage initialized and schedule posted.");
    }
    if (action === "daily") {
      await runDailyJob(env, true);
      return new Response("Daily job ran.");
    }
    if (action === "live") {
      await runLivePolling(env);
      return new Response("Live polling ran.");
    }
    if (action === "hourly") {
      await runHourlyCheck(env);
      return new Response("Hourly check ran.");
    }
    if (action === "midnight") {
      await runMidnightCheck(env);
      return new Response("Midnight check ran.");
    }
    if (action === "reset_fixture") {
      const id = url.searchParams.get("id");
      if (!id) return new Response("Missing ?id=", { status: 400 });
      await env.DB.prepare("DELETE FROM seen_events WHERE fixture_id = ?").bind(id).run();
      await env.DB.prepare("UPDATE fixtures SET status = 'NS', stats_pending = 0 WHERE id = ?").bind(id).run();
      return new Response(`Fixture ${id} reset.`);
    }
    if (action === "status") {
      const gamesToday   = await env.KV.get(KV_GAMES_TODAY);
      const gameImminent = await env.KV.get(KV_GAME_IMMINENT);
      return new Response(
        `games_today=${gamesToday}\ngame_imminent=${gameImminent}`
      );
    }

    return new Response(
      "WC2026 Bot running.\n\n" +
      "Manual triggers (GET):\n" +
      "  ?action=init                 - One-time: load group stage fixtures + post schedule\n" +
      "  ?action=daily                - Run daily job (post tomorrow's schedule)\n" +
      "  ?action=midnight             - Run midnight check (set games_today flag)\n" +
      "  ?action=hourly               - Run hourly check (set game_imminent flag)\n" +
      "  ?action=live                 - Force-run live polling right now\n" +
      "  ?action=status               - Show current KV flags\n" +
      "  ?action=reset_fixture&id=ID  - Reset a fixture state for retesting\n"
    );
  },
};

// ─── Midnight Check ───────────────────────────────────────────────────────────
// Runs at 00:00 UTC. Checks D1 for any fixtures today. Sets KV flag.

async function runMidnightCheck(env) {
  const today    = utcDate(0);
  const fixtures = await getFixturesByDate(env.DB, today);

  // Filter to followed countries if in group stage
  const relevant = today <= GROUP_STAGE_END
    ? filterFixtures(fixtures, "group")
    : fixtures;

  const hasGames = relevant.length > 0;
  await env.KV.put(KV_GAMES_TODAY, hasGames ? "1" : "0", {
    expirationTtl: 60 * 60 * 26, // expire after 26 hours
  });
  // Reset imminent flag at midnight
  await env.KV.put(KV_GAME_IMMINENT, "0", { expirationTtl: 60 * 60 * 26 });
  console.log(`Midnight check: games_today=${hasGames}, ${relevant.length} fixtures found.`);
}

// ─── Hourly Check ─────────────────────────────────────────────────────────────
// Runs every hour. Only does work if games_today=1.
// Checks if any fixture kicks off within the next 70 minutes.

async function runHourlyCheck(env) {
  const gamesToday = await env.KV.get(KV_GAMES_TODAY);
  if (gamesToday !== "1") {
    console.log("Hourly check: no games today, skipping.");
    return;
  }

  const today    = utcDate(0);
  const fixtures = await getFixturesByDate(env.DB, today);
  const now      = Date.now();

  // A game is "imminent" if it kicks off within the next 70 minutes
  // OR if it's already in progress (kickoff was in the last 120 minutes and not FT)
  const imminent = fixtures.some((f) => {
    const kickoff = new Date(f.kickoff_utc).getTime();
    const minsUntil  = (kickoff - now) / 60000;
    const minsAgo    = (now - kickoff) / 60000;
    const notFinished = !["FT", "AET", "PEN"].includes(f.status);
    return (minsUntil >= 0 && minsUntil <= 70) || (minsAgo >= 0 && minsAgo <= 120 && notFinished);
  });

  await env.KV.put(KV_GAME_IMMINENT, imminent ? "1" : "0", {
    expirationTtl: 60 * 60 * 2,
  });
  console.log(`Hourly check: game_imminent=${imminent}`);
}

// ─── Minute Poll ──────────────────────────────────────────────────────────────
// Runs every minute. Exits immediately if game_imminent is not set.

async function runMinutePoll(env) {
  const imminent = await env.KV.get(KV_GAME_IMMINENT);
  if (imminent !== "1") return; // Exit instantly — no game imminent

  await runLivePolling(env);
  await runStatsRetry(env);

  // After polling, check if all active games are now finished AND no
  // fixture is still waiting on a final-stats retry. If so, clear the
  // imminent flag so the minute cron goes back to sleep.
  const activeInDb  = await getActiveFixtures(env.DB, activeFixtureFilter());
  const pendingStats = await getFixturesPendingStats(env.DB);
  if (activeInDb.length === 0 && pendingStats.length === 0) {
    await env.KV.put(KV_GAME_IMMINENT, "0", { expirationTtl: 60 * 60 * 2 });
    console.log("All games finished and no pending stats — cleared game_imminent flag.");
  }
}

// ─── Live Polling ─────────────────────────────────────────────────────────────

async function runLivePolling(env) {
  const activeInDb = await getActiveFixtures(env.DB, activeFixtureFilter());
  if (activeInDb.length === 0) return;

  // Fetch today's full scoreboard — includes live scores and status
  let liveEvents;
  try {
    liveEvents = await fetchLiveFixtures(env);
  } catch (err) {
    console.error("Failed to fetch live fixtures from ESPN:", err);
    return;
  }

  const liveById = new Map(liveEvents.map((e) => [parseInt(e.id, 10), e]));

  for (const dbFixture of activeInDb) {
    const espnEvent = liveById.get(dbFixture.id);
    if (!espnEvent) {
      await checkIfFinished(env, dbFixture);
      continue;
    }
    await processLiveFixture(env, dbFixture, espnEvent);
  }
}

async function processLiveFixture(env, dbFixture, espnEvent) {
  const comp       = espnEvent.competitions?.[0];
  const statusType = comp?.status?.type;
  const state      = statusType?.state;
  const statusName = statusType?.name || "";
  const prevStatus = dbFixture.status;

  const home      = comp?.competitors?.find((c) => c.homeAway === "home");
  const away      = comp?.competitors?.find((c) => c.homeAway === "away");
  const homeScore = parseInt(home?.score || "0", 10);
  const awayScore = parseInt(away?.score || "0", 10);

  // Kickoff
  if (prevStatus === "NS" && state === ESPN_STATUS.IN && statusName !== "STATUS_HALFTIME") {
    await postToGroupMe(env, formatKickoff(dbFixture));
    await updateFixtureStatus(env.DB, dbFixture.id, "LIVE");
    return;
  }

  // Half time
  if (statusName === "STATUS_HALFTIME" && prevStatus !== "HT") {
    let htStats = null;
    try {
      htStats = await fetchStats(env, dbFixture.id);
    } catch (err) {
      console.error(`Could not fetch HT stats for ${dbFixture.id}:`, err);
    }
    // One-time diagnostic: HT is the most reliable point to capture a real
    // stats shape, since FT stats are sometimes still empty at the moment
    // the match ends. Shares the same per-fixture flag as the FT capture
    // below, so only the first one to fire actually logs anything.
    await logRawShapeOnce(env, `stats_shape_${dbFixture.id}`, "boxscore_team", htStats?.[0]);
    await postToGroupMe(env, formatHalfTime(dbFixture, homeScore, awayScore, htStats));
    await updateFixtureStatus(env.DB, dbFixture.id, "HT");
    return;
  }

  // Second half resumes after HT
  if (prevStatus === "HT" && state === ESPN_STATUS.IN && statusName !== "STATUS_HALFTIME") {
    await updateFixtureStatus(env.DB, dbFixture.id, "LIVE");
  }

  // Full time
  if (state === ESPN_STATUS.POST && !["FT", "AET", "PEN"].includes(prevStatus)) {
    const ftStatus = deriveFullTimeStatus(statusName);
    await handleMatchEnd(env, dbFixture, espnEvent, homeScore, awayScore, ftStatus);
    return;
  }

  // Live events during play — pass current score from scoreboard
  if (state === ESPN_STATUS.IN && statusName !== "STATUS_HALFTIME") {
    await pollAndPostEvents(env, dbFixture, homeScore, awayScore);
  }
}

async function pollAndPostEvents(env, dbFixture, homeScore, awayScore) {
  // We only care about goals here (no live commentary source available).
  // A goal is detected by comparing the current scoreboard score to the
  // last-known score stored in seen_events — far more reliable than trying
  // to dedupe individual play-by-play entries, which ESPN sometimes reports
  // with shifting clock values between polls.

  const seen = await getSeenEvents(env.DB, dbFixture.id);
  const scoreKey = `score_${homeScore}_${awayScore}`;

  if (seen.has(scoreKey)) return; // Already posted this score state
  if (homeScore === 0 && awayScore === 0) {
    // Nothing has happened yet — record the 0-0 state so we don't miss
    // detecting it later, but don't post anything.
    await insertSeenEvent(env.DB, dbFixture.id, scoreKey);
    return;
  }

  // Score changed since last seen — find which goal play matches this score.
  let plays;
  try {
    plays = await fetchEvents(env, dbFixture.id);
  } catch (err) {
    console.error(`Failed to fetch plays for fixture ${dbFixture.id}:`, err);
    // Still record the score so we don't loop forever retrying
    await insertSeenEvent(env.DB, dbFixture.id, scoreKey);
    return;
  }

  const goalPlays = (plays || []).filter((p) =>
    (p.type?.text || "").toLowerCase().includes("goal")
  );

  // One-time diagnostic: capture the raw shape of a goal play so the actual
  // ESPN field names for a play's running score can be confirmed (see the
  // findGoalMatchingScore guesses below). Logs once per fixture, then never
  // again — won't spam event_log across the rest of the match.
  await logRawShapeOnce(env, `goal_play_shape_${dbFixture.id}`, "goal_play", goalPlays[0] || plays[0]);

  // IMPORTANT: don't assume the *last* goal play in the array is the one
  // that produced the *current* scoreboard score — ESPN's /plays feed and
  // the scoreboard score can be a poll or two out of sync with each other.
  // Instead, find the goal play whose own running score actually matches
  // homeScore/awayScore. ESPN goal plays carry the score the match was AT
  // after that goal under awayScore/homeScore (or scoreValue) fields on
  // the play itself when present; fall back to position-based matching
  // only if no play's own score lines up, and fall back further to a
  // generic message (no stale minute) if we still can't tell.
  const matchingGoal = findGoalMatchingScore(goalPlays, homeScore, awayScore);
  const latestGoal    = matchingGoal || goalPlays[goalPlays.length - 1];

  // If we can't find an exact score match AND the play list doesn't even
  // have as many goals as the new total score implies, the /plays feed is
  // simply behind — post the generic (minute-less) goal message instead of
  // repeating a stale minute from an earlier goal.
  const totalGoalsImplied = homeScore + awayScore;
  const feedLooksStale    = !matchingGoal && goalPlays.length < totalGoalsImplied;

  const msg = !feedLooksStale && latestGoal
    ? formatEvent(latestGoal, dbFixture, homeScore, awayScore)
    : formatGenericGoal(dbFixture, homeScore, awayScore);

  if (msg) await postToGroupMe(env, msg);
  await insertSeenEvent(env.DB, dbFixture.id, scoreKey);
}

/**
 * Look through goalPlays for the one whose own recorded score matches the
 * scoreboard's current homeScore/awayScore. ESPN's play objects sometimes
 * carry the post-goal score under different keys depending on the feed
 * version, so we check a few plausible shapes.
 */
function findGoalMatchingScore(goalPlays, homeScore, awayScore) {
  for (let i = goalPlays.length - 1; i >= 0; i--) {
    const p = goalPlays[i];
    const playHome = p.homeScore ?? p.scoreValue?.home ?? p.team?.score?.home;
    const playAway = p.awayScore ?? p.scoreValue?.away ?? p.team?.score?.away;
    if (playHome != null && playAway != null) {
      if (parseInt(playHome, 10) === homeScore && parseInt(playAway, 10) === awayScore) {
        return p;
      }
    }
  }
  return null;
}

async function handleMatchEnd(env, dbFixture, espnEvent, homeScore, awayScore, ftStatus) {
  let stats = null;
  try {
    stats = await fetchStats(env, dbFixture.id);
  } catch (err) {
    console.error(`Could not fetch stats for ${dbFixture.id}:`, err);
  }

  // One-time diagnostic: capture the raw shape of a boxscore team's stats
  // so the actual ESPN stat names (corners, fouls, etc.) can be confirmed
  // against what formatStatsBlock's alias list expects. Logs once per
  // fixture, then never again.
  await logRawShapeOnce(env, `stats_shape_${dbFixture.id}`, "boxscore_team", stats?.[0]);

  // Write status BEFORE posting to GroupMe (avoids re-posting FULL TIME
  // repeatedly if the GroupMe call itself fails).
  await updateFixtureStatus(env.DB, dbFixture.id, ftStatus);
  await setFinalScore(env.DB, dbFixture.id, homeScore, awayScore);

  const msg = formatFullTime(dbFixture, homeScore, awayScore, stats, ftStatus);
  await postToGroupMe(env, msg);

  // ESPN's boxscore frequently isn't populated yet in the same instant the
  // match flips to "post" status — ask the minute-poll cron to retry stats
  // shortly after, and post a short FINAL STATS follow-up if/when they show up.
  if (!stats || stats.length < 2) {
    await markStatsPending(env.DB, dbFixture.id);
    console.log(`FT stats not ready yet for fixture ${dbFixture.id} — will retry.`);
  }

  console.log(`Match ended: ${dbFixture.home} ${homeScore}-${awayScore} ${dbFixture.away} (${ftStatus})`);
}

/**
 * Retries fetching stats for any recently-finished fixture still flagged
 * as stats_pending. Runs as part of the minute poll. Posts a FINAL STATS
 * follow-up message as soon as stats become available, then clears the
 * flag. Gives up (clearing the flag without posting) after enough retries
 * that another minute cron run won't keep trying forever.
 */
async function runStatsRetry(env) {
  const pending = await getFixturesPendingStats(env.DB);
  if (pending.length === 0) return;

  for (const fixture of pending) {
    let stats = null;
    try {
      stats = await fetchStats(env, fixture.id);
    } catch (err) {
      console.error(`Stats retry fetch failed for fixture ${fixture.id}:`, err);
    }

    if (stats && stats.length >= 2) {
      const msg = formatFinalStatsFollowUp(
        fixture,
        fixture.final_home_score,
        fixture.final_away_score,
        stats
      );
      if (msg) {
        await postToGroupMe(env, msg);
        await clearStatsPending(env.DB, fixture.id);
        console.log(`Posted delayed FINAL STATS for fixture ${fixture.id}.`);
        continue;
      }
    }

    const attempts = (await getRetryCount(env.DB, fixture.id)) + 1;
    await setRetryCount(env.DB, fixture.id, attempts);
    if (attempts >= FT_STATS_MAX_RETRIES) {
      await clearStatsPending(env.DB, fixture.id);
      console.log(`Giving up on FT stats retry for fixture ${fixture.id} after ${attempts} attempts.`);
    }
  }
}

const RETRY_STATE_PREFIX = "ft_stats_retries_";

async function getRetryCount(db, fixtureId) {
  const val = await getState(db, `${RETRY_STATE_PREFIX}${fixtureId}`);
  return val ? parseInt(val, 10) : 0;
}

async function setRetryCount(db, fixtureId, count) {
  await setState(db, `${RETRY_STATE_PREFIX}${fixtureId}`, String(count));
}

// ─── One-Time Shape Capture ───────────────────────────────────────────────────
// Temporary diagnostic aid: writes the raw ESPN object for a goal play or a
// boxscore team's stats to event_log (visible in the admin dashboard's
// activity feed) the FIRST time we see one for a given fixture, then never
// again for that fixture — so this can't spam the log across a full match.
// Safe to remove once the real field names (goal score fields, stat names)
// have been confirmed from a live response.

async function logRawShapeOnce(env, stateKey, label, payload) {
  if (!payload) return;
  const already = await getState(env.DB, stateKey);
  if (already === "1") return;
  await setState(env.DB, stateKey, "1");
  const json = JSON.stringify(payload);
  // event_log.message is a plain TEXT column with no length cap enforced
  // here — truncate defensively so one giant object can't bloat the table.
  const truncated = json.length > 4000 ? json.slice(0, 4000) + "...[truncated]" : json;
  await writeEventLog(env.DB, "debug", `[shape-capture:${label}] ${truncated}`);
  console.log(`[shape-capture:${label}]`, json);
}

async function checkIfFinished(env, dbFixture) {
  try {
    const today    = utcDate(0);
    const fixtures = await fetchFixturesByDate(env, today, dbFixture.stage);
    const match    = fixtures.find((f) => f.id === dbFixture.id);
    if (!match) return;
    if (match.espn_status === ESPN_STATUS.POST) {
      await updateFixtureStatus(env.DB, dbFixture.id, "FT");
    }
  } catch (err) {
    console.error(`checkIfFinished error for fixture ${dbFixture.id}:`, err);
  }
}

// ─── Initialization ───────────────────────────────────────────────────────────

async function initGroupStage(env) {
  const already = await getState(env.DB, "group_schedule_posted");
  if (already === "1") {
    console.log("Group stage already initialized.");
    return;
  }

  console.log("Fetching group stage fixtures from ESPN...");
  const all      = await fetchFixturesInRange(env, GROUP_STAGE_START, GROUP_STAGE_END, "group");
  const filtered = filterFixtures(all, "group");

  await upsertFixtures(env.DB, all);

  const msg = formatGroupStageSchedule(
    filtered,
    FOLLOWED_COUNTRIES !== null,
    FOLLOWED_COUNTRIES || []
  );
  await postToGroupMe(env, msg);
  await setState(env.DB, "group_schedule_posted", "1");
  console.log(`Group stage initialized. ${all.length} fixtures stored, ${filtered.length} in schedule post.`);
}

// ─── Daily Job (8AM UTC) ──────────────────────────────────────────────────────

async function runDailyJob(env, force = false) {
  const today    = utcDate(0);
  const tomorrow = utcDate(1);

  if (today <= GROUP_STAGE_END) {
    const initialized = await getState(env.DB, "group_schedule_posted");
    if (!initialized) await initGroupStage(env);
    return;
  }

  const stateKey      = `daily_schedule_${tomorrow}`;
  const alreadyPosted = await getState(env.DB, stateKey);
  if (alreadyPosted === "1" && !force) return;

  const raw      = await fetchFixturesByDate(env, tomorrow, "knockout");
  await upsertFixtures(env.DB, raw);

  const fixtures = await getFixturesByDate(env.DB, tomorrow);
  const label    = `Tomorrow - ${readableDate(tomorrow)}`;
  const msg      = formatDailySchedule(fixtures, label);
  await postToGroupMe(env, msg);
  await setState(env.DB, stateKey, "1");
  console.log(`Daily schedule posted for ${tomorrow}: ${fixtures.length} fixtures.`);
}

// ─── Country Filter ───────────────────────────────────────────────────────────

function filterFixtures(fixtures, stage) {
  if (stage === "knockout") return fixtures;
  if (!FOLLOWED_COUNTRIES || FOLLOWED_COUNTRIES.length === 0) return fixtures;
  const set = new Set(FOLLOWED_COUNTRIES.map((c) => c.toLowerCase()));
  return fixtures.filter(
    (f) => set.has(f.home.toLowerCase()) || set.has(f.away.toLowerCase())
  );
}

/**
 * Returns a filter function for getActiveFixtures() that restricts results
 * to followed countries during the group stage (knockout stage always
 * tracks everything). Used by both runLivePolling and runMinutePoll so the
 * two stay in agreement about what counts as "active".
 */
function activeFixtureFilter() {
  return (f) => {
    const isGroupStage = f.kickoff_utc.split("T")[0] <= GROUP_STAGE_END;
    if (!isGroupStage) return true;
    if (!FOLLOWED_COUNTRIES || FOLLOWED_COUNTRIES.length === 0) return true;
    const set = new Set(FOLLOWED_COUNTRIES.map((c) => c.toLowerCase()));
    return set.has(f.home.toLowerCase()) || set.has(f.away.toLowerCase());
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deriveFullTimeStatus(statusName) {
  if (!statusName) return "FT";
  const s = statusName.toLowerCase();
  if (s.includes("extra") || s.includes("aet")) return "AET";
  if (s.includes("penalty") || s.includes("pen")) return "PEN";
  return "FT";
}

function utcDate(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

function readableDate(dateStr) {
  return new Date(dateStr + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday:  "long",
    month:    "long",
    day:      "numeric",
    timeZone: "UTC",
  });
  }
