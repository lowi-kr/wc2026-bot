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
import { formatGroupStageSchedule, formatDailySchedule, formatKickoff, formatSecondHalfKickoff, formatHalfTime, formatFullTime, formatFinalStatsFollowUp, formatEvent, formatGenericGoal, formatPhaseTransition, formatLiveReply, formatFinishedReply, formatStatsReply, formatGoalsReply, formatNoMatchReply, formatAmbiguousReply, formatCommandHelp } from "./formatter.js";
import {
  upsertFixtures, getFixturesByDate, getActiveFixtures, getFixturesPendingStats,
  updateFixtureStatus, markStatsPending, clearStatsPending, setFinalScore,
  getSeenEvents, insertSeenEvent, getState, setState,
  findFixtureByTeam, getCurrentlyLiveFixtures, getMostRecentFinishedFixture,
  logEvent, getRecentLogs, trimEventLog,
} from "./db.js";
import { handleAdminRequest } from "./admin.js";

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
const GROUP_STAGE_END   = "2026-06-26";

// KV keys
const KV_GAMES_TODAY    = "games_today";      // "1" or "0"
const KV_GAME_IMMINENT  = "game_imminent";    // "1" or "0"

// How many times to retry fetching full-time stats if they weren't ready
// at the moment FULL TIME was posted, before giving up silently.
const FT_STATS_MAX_RETRIES = 5;

// Job functions handed to admin.js so the dashboard's "manual run" buttons
// can call the real cron logic without a circular import.
const JOB_FNS = {
  runDailyJob,
  runHourlyCheck,
  runMidnightCheck,
  runLivePolling,
};

// ─── Cron Entry Point ─────────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron;

    if (cron === "0 0 * * *") {
      // Midnight UTC — check if there are games today
      ctx.waitUntil(runMidnightCheck(env));
      // Opportunistic cleanup so event_log doesn't grow forever
      ctx.waitUntil(trimEventLog(env.DB, 500));
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

  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const action = url.searchParams.get("action");

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdminRequest(request, env, ctx, url, JOB_FNS);
    }

    if (request.method === "POST" && url.pathname === "/groupme-webhook") {
      // GroupMe expects a fast 2xx ack; do the actual work in the background.
      ctx.waitUntil(handleGroupMeCallback(env, request));
      return new Response("ok");
    }

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
      await logEvent(env.DB, "info", `[action=reset_fixture] fixture ${id} reset to NS`);
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
      "Dashboard:\n" +
      "  /admin                       - Password-protected admin dashboard\n\n" +
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
  await logEvent(
    env.DB,
    "info",
    `[midnight] games_today=${hasGames} (${relevant.length} fixture(s) found for ${today})`
  );
}

// ─── Hourly Check ─────────────────────────────────────────────────────────────
// Runs every hour. Only does work if games_today=1.
// Asks ESPN directly whether anything is live or about to kick off — this is
// deliberately NOT based on D1's cached kickoff_utc/status. A cached kickoff
// time can drift (we found one off by an hour), and a wall-clock cutoff based
// on it can end tracking mid-match. ESPN's own `state` stays "in" for the
// entire match — regulation, halftime, extra time, stoppage, penalties — and
// only flips to "post" once it's actually over, so trusting it directly here
// removes the guesswork entirely.

async function runHourlyCheck(env) {
  const gamesToday = await env.KV.get(KV_GAMES_TODAY);
  if (gamesToday !== "1") {
    console.log("Hourly check: no games today, skipping.");
    return;
  }

  const today = utcDate(0);
  let espnFixtures;
  try {
    espnFixtures = await fetchFixturesByDate(env, today, undefined);
  } catch (err) {
    // Transient ESPN error — do NOT clear game_imminent on a fetch failure.
    // Leaving the existing KV value in place is the fail-safe choice: worst
    // case we poll one extra hour we didn't need to, instead of silently
    // dropping a live match because ESPN hiccuped for one request.
    console.error("Hourly check: failed to fetch ESPN scoreboard:", err);
    await logEvent(env.DB, "error", `[hourly] failed to fetch ESPN scoreboard, leaving game_imminent unchanged: ${err.message}`);
    return;
  }

  const relevant = today <= GROUP_STAGE_END ? filterFixtures(espnFixtures, "group") : espnFixtures;
  const now = Date.now();

  const imminent = relevant.some((f) => {
    if (f.espn_status === ESPN_STATUS.IN) return true; // live right now, per ESPN — covers HT/ET/stoppage/shootout
    const kickoff = new Date(f.kickoff_utc).getTime();
    const minsUntil = (kickoff - now) / 60000;
    return minsUntil >= 0 && minsUntil <= 70; // about to start
  });

  await env.KV.put(KV_GAME_IMMINENT, imminent ? "1" : "0", {
    expirationTtl: 60 * 60 * 2,
  });
  console.log(`Hourly check: game_imminent=${imminent} (source: ESPN live scoreboard)`);
  await logEvent(env.DB, "info", `[hourly] game_imminent=${imminent} (source: ESPN live scoreboard)`);
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
  const activeInDb   = await getActiveFixtures(env.DB);
  const pendingStats = await getFixturesPendingStats(env.DB);
  if (activeInDb.length === 0 && pendingStats.length === 0) {
    await env.KV.put(KV_GAME_IMMINENT, "0", { expirationTtl: 60 * 60 * 2 });
    console.log("All games finished and no pending stats — cleared game_imminent flag.");
    await logEvent(env.DB, "info", "[minute] all active games finished, no pending stats — cleared game_imminent");
  }
}

// ─── Live Polling ─────────────────────────────────────────────────────────────

async function runLivePolling(env) {
  const activeInDb = await getActiveFixtures(env.DB);
  if (activeInDb.length === 0) return;

  // Fetch today's full scoreboard — includes live scores and status
  let liveEvents;
  try {
    liveEvents = await fetchLiveFixtures(env);
  } catch (err) {
    console.error("Failed to fetch live fixtures from ESPN:", err);
    await logEvent(env.DB, "error", `[live] failed to fetch live fixtures from ESPN: ${err.message}`);
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
  const comp        = espnEvent.competitions?.[0];
  const statusType  = comp?.status?.type;
  const state       = statusType?.state;
  const statusName  = statusType?.name || "";
  const statusDetail = statusType?.detail || statusType?.description || statusType?.shortDetail || "";
  const period      = comp?.status?.period ?? null;
  const prevStatus  = dbFixture.status;

  const home      = comp?.competitors?.find((c) => c.homeAway === "home");
  const away      = comp?.competitors?.find((c) => c.homeAway === "away");
  const homeScore = parseInt(home?.score || "0", 10);
  const awayScore = parseInt(away?.score || "0", 10);

  // Kickoff
  if (prevStatus === "NS" && state === ESPN_STATUS.IN && statusName !== "STATUS_HALFTIME") {
    await postToGroupMe(env, formatKickoff(dbFixture));
    await updateFixtureStatus(env.DB, dbFixture.id, "LIVE");
    await logEvent(env.DB, "info", `[live] kickoff posted: ${dbFixture.home} vs ${dbFixture.away} (id ${dbFixture.id})`);
    return;
  }

  // Half time
  if (statusName === "STATUS_HALFTIME" && prevStatus !== "HT") {
    let htStats = null;
    try {
      htStats = await fetchStats(env, dbFixture.id);
    } catch (err) {
      console.error(`Could not fetch HT stats for ${dbFixture.id}:`, err);
      await logEvent(env.DB, "warn", `[live] could not fetch HT stats for fixture ${dbFixture.id}: ${err.message}`);
    }
    // One-time diagnostic: HT is the most reliable point to capture a real
    // stats shape, since FT stats are sometimes still empty at the moment
    // the match ends. Shares the same per-fixture flag as the FT capture
    // in handleMatchEnd, so only the first one to fire actually logs.
    await logRawShapeOnce(env, `stats_shape_${dbFixture.id}`, "boxscore_team", htStats?.[0]);
    await postToGroupMe(env, formatHalfTime(dbFixture, homeScore, awayScore, htStats));
    await updateFixtureStatus(env.DB, dbFixture.id, "HT");
    await logEvent(env.DB, "info", `[live] half-time posted: ${dbFixture.home} ${homeScore}-${awayScore} ${dbFixture.away}`);
    return;
  }

  // Second half resumes after HT
  if (prevStatus === "HT" && state === ESPN_STATUS.IN && statusName !== "STATUS_HALFTIME") {
    await postToGroupMe(env, formatSecondHalfKickoff(dbFixture, homeScore, awayScore));
    await updateFixtureStatus(env.DB, dbFixture.id, "LIVE");
    await logEvent(env.DB, "info", `[live] second-half kickoff posted: ${dbFixture.home} ${homeScore}-${awayScore} ${dbFixture.away}`);
  }

  // Extra time / shootout phase transitions (kickoff of ET, ET half-time,
  // second ET half, shootout start). Best-effort: see checkExtraTimePhases
  // for why the detection here is defensive rather than exact-string-match.
  if (state === ESPN_STATUS.IN) {
    await checkExtraTimePhases(env, dbFixture, statusName, statusDetail, period, homeScore, awayScore);
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

/**
 * Detect and announce extra-time / penalty-shootout phase transitions.
 *
 * IMPORTANT CAVEAT: unlike goal detection (which we've verified against real
 * live matches), ESPN's exact status.type.name / detail strings for extra
 * time and shootouts in this competition are NOT independently confirmed —
 * no match had reached extra time at the time this was written. Rather than
 * hardcode one guessed string and risk silently missing the transition
 * entirely (the same failure mode as the goal-detection bug), this checks
 * several defensive signals (name, free-text detail, period number) at once.
 * The raw status shape is logged the first time any of them fire, via the
 * same one-shot diagnostic pattern used for stats shapes, so the detection
 * can be tightened against real data the moment it's actually exercised.
 */
async function checkExtraTimePhases(env, dbFixture, statusName, statusDetail, period, homeScore, awayScore) {
  const name   = (statusName || "").toUpperCase();
  const detail = (statusDetail || "").toLowerCase();

  const looksShootout = name.includes("SHOOTOUT") || detail.includes("shootout") || detail.includes("penalty shoot");
  const looksExtra    = !looksShootout && (
    name.includes("EXTRA") || name.includes("_ET") ||
    detail.includes("extra time") ||
    (typeof period === "number" && period >= 3)
  );

  let phase = null;
  if (looksShootout) {
    phase = "shootout";
  } else if (looksExtra) {
    const looksHalftime = name.includes("HALFTIME") || detail.includes("half-time") || detail.includes("halftime");
    if (looksHalftime) phase = "et_halftime";
    else if (typeof period === "number" && period >= 4) phase = "et_second_half";
    else phase = "et_first_half";
  }

  if (!phase) return;

  const key  = `extra_phase_${dbFixture.id}`;
  const last = await getState(env.DB, key);
  if (last === phase) return; // already announced this phase
  await setState(env.DB, key, phase);

  await logRawShapeOnce(env, `extra_time_shape_${dbFixture.id}`, "status_object", { statusName, statusDetail, period });

  const msg = formatPhaseTransition(phase, dbFixture, homeScore, awayScore);
  if (msg) {
    await postToGroupMe(env, msg);
    await logEvent(env.DB, "info", `[live] phase transition posted: ${phase} for fixture ${dbFixture.id} (${dbFixture.home} vs ${dbFixture.away})`);
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
    await logEvent(env.DB, "warn", `[live] failed to fetch plays for fixture ${dbFixture.id}: ${err.message}`);
    // Still record the score so we don't loop forever retrying
    await insertSeenEvent(env.DB, dbFixture.id, scoreKey);
    return;
  }

  // Filter to actual scoring plays using ESPN's confirmed boolean field.
  // IMPORTANT: .includes("goal") on type.text is WRONG — "Goal Kick" has
  // type.text="Goal Kick" and matches, flooding goalPlays with routine
  // restarts that happen many times per half. This was the real root cause
  // of the stale/wrong goal minute: goalPlays[length-1] kept returning the
  // most recent Goal Kick, not the actual goal. scoringPlay===true is the
  // confirmed correct filter (verified from a live ESPN play object for
  // this tournament: Goal Kick has scoringPlay=false, confirmed 2026-06-29).
  const goalPlays = (plays || []).filter((p) => p.scoringPlay === true);

  // One-time diagnostic re-keyed as _v2 so it captures a real *scoring*
  // play — the _v1 capture earlier in this match grabbed a Goal Kick instead
  // (because the old filter was wrong). This fires once on the next goal.
  await logRawShapeOnce(env, `goal_play_shape_v2_${dbFixture.id}`, "goal_play", goalPlays[0] || plays[0]);

  // Find the scoring play whose homeScore/awayScore fields match the current
  // scoreboard. p.homeScore and p.awayScore are confirmed present on every
  // ESPN play object (verified from live data 2026-06-29).
  const matchingGoal = findGoalMatchingScore(goalPlays, homeScore, awayScore);
  const latestGoal    = matchingGoal || goalPlays[goalPlays.length - 1];

  const totalGoalsImplied = homeScore + awayScore;
  const feedLooksStale    = !matchingGoal && goalPlays.length < totalGoalsImplied;

  const msg = !feedLooksStale && latestGoal
    ? formatEvent(latestGoal, dbFixture, homeScore, awayScore)
    : formatGenericGoal(dbFixture, homeScore, awayScore);

  if (msg) await postToGroupMe(env, msg);
  await insertSeenEvent(env.DB, dbFixture.id, scoreKey);
  await logEvent(env.DB, "info", `[live] goal posted: ${dbFixture.home} ${homeScore}-${awayScore} ${dbFixture.away}`);
}

/**
 * Find the scoring play whose post-goal score matches the current scoreboard.
 * p.homeScore and p.awayScore are confirmed present on ESPN play objects
 * (verified from live WC2026 data 2026-06-29).
 */
function findGoalMatchingScore(goalPlays, homeScore, awayScore) {
  for (let i = goalPlays.length - 1; i >= 0; i--) {
    const p = goalPlays[i];
    if (parseInt(p.homeScore, 10) === homeScore && parseInt(p.awayScore, 10) === awayScore) {
      return p;
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
    await logEvent(env.DB, "warn", `[live] could not fetch FT stats for fixture ${dbFixture.id}: ${err.message}`);
  }

  // One-time diagnostic, in case HT never fired (e.g. a match that went
  // straight from kickoff to some state we didn't catch HT for).
  await logRawShapeOnce(env, `stats_shape_${dbFixture.id}`, "boxscore_team", stats?.[0]);

  const { winner, shootout } = extractWinnerAndShootout(espnEvent, homeScore, awayScore);

  // Write status BEFORE posting to GroupMe (avoids re-posting FULL TIME
  // repeatedly if the GroupMe call itself fails).
  await updateFixtureStatus(env.DB, dbFixture.id, ftStatus);
  await setFinalScore(env.DB, dbFixture.id, homeScore, awayScore);

  const msg = formatFullTime(dbFixture, homeScore, awayScore, stats, ftStatus, shootout, winner);
  await postToGroupMe(env, msg);

  // ESPN's boxscore frequently isn't populated yet in the same instant the
  // match flips to "post" status — ask the minute-poll cron to retry stats
  // shortly after, and post a short FINAL STATS follow-up if/when they show up.
  if (!stats || stats.length < 2) {
    await markStatsPending(env.DB, dbFixture.id);
    console.log(`FT stats not ready yet for fixture ${dbFixture.id} — will retry.`);
    await logEvent(env.DB, "info", `[live] FT stats not ready for fixture ${dbFixture.id} — queued for retry`);
  }

  console.log(`Match ended: ${dbFixture.home} ${homeScore}-${awayScore} ${dbFixture.away} (${ftStatus})`);
  await logEvent(
    env.DB,
    "info",
    `[live] match ended: ${dbFixture.home} ${homeScore}-${awayScore} ${dbFixture.away} (${ftStatus})`
  );
}

/**
 * Pull a winner flag and (if available) a penalty shootout score out of
 * the raw ESPN event. ESPN marks the winning competitor with a boolean
 * `winner: true/false` on each entry in competitions[0].competitors —
 * this is authoritative and correctly reflects shootout outcomes, unlike
 * comparing homeScore/awayScore (which are level by definition whenever a
 * match actually went to penalties).
 *
 * Shootout score field name is unverified — ESPN doesn't consistently
 * expose it in the same place across feeds. We try a couple of plausible
 * paths and fall back to null (formatFullTime then just says "Decided on
 * penalties" without a shootout score, which is the safe behavior when we
 * can't confirm a number rather than guessing).
 */
function extractWinnerAndShootout(espnEvent, homeScore, awayScore) {
  const comp = espnEvent?.competitions?.[0];
  const home = comp?.competitors?.find((c) => c.homeAway === "home");
  const away = comp?.competitors?.find((c) => c.homeAway === "away");

  let winner = null;
  if (home?.winner === true) winner = "home";
  else if (away?.winner === true) winner = "away";
  else if (home?.winner === false && away?.winner === false) winner = "draw";
  // If neither side has a winner flag at all (undefined on both), leave
  // winner as null so formatFullTime falls back to score comparison.

  let shootout = null;
  const homeShootout = home?.shootoutScore ?? home?.penaltyScore ?? home?.score?.shootout;
  const awayShootout = away?.shootoutScore ?? away?.penaltyScore ?? away?.score?.shootout;
  if (homeShootout != null && awayShootout != null) {
    shootout = { home: parseInt(homeShootout, 10), away: parseInt(awayShootout, 10) };
  }

  return { winner, shootout };
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
      await logEvent(env.DB, "warn", `[stats-retry] fetch failed for fixture ${fixture.id}: ${err.message}`);
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
        await logEvent(env.DB, "info", `[stats-retry] posted delayed FINAL STATS for fixture ${fixture.id}`);
        continue;
      }
    }

    const attempts = (await getRetryCount(env.DB, fixture.id)) + 1;
    await setRetryCount(env.DB, fixture.id, attempts);
    if (attempts >= FT_STATS_MAX_RETRIES) {
      await clearStatsPending(env.DB, fixture.id);
      console.log(`Giving up on FT stats retry for fixture ${fixture.id} after ${attempts} attempts.`);
      await logEvent(env.DB, "warn", `[stats-retry] gave up on fixture ${fixture.id} after ${attempts} attempts`);
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
// Safe to remove once the real field names (goal score fields, stat names,
// shootout score field) have been confirmed from a live response.

async function logRawShapeOnce(env, stateKey, label, payload) {
  if (!payload) return;
  const already = await getState(env.DB, stateKey);
  if (already === "1") return;
  await setState(env.DB, stateKey, "1");
  const json = JSON.stringify(payload);
  // event_log.message is a plain TEXT column with no length cap enforced
  // here — truncate defensively so one giant object can't bloat the table.
  const truncated = json.length > 4000 ? json.slice(0, 4000) + "...[truncated]" : json;
  await logEvent(env.DB, "debug", `[shape-capture:${label}] ${truncated}`);
  console.log(`[shape-capture:${label}]`, json);
}

async function checkIfFinished(env, dbFixture) {
  try {
    // Use the fixture's OWN kickoff date, not "today" — if this runs after
    // the fixture's UTC calendar day has rolled over (common for late-night
    // kickoffs), querying "today" would never find the match again and this
    // fixture would stay stuck as "active" forever.
    const fixtureDate = dbFixture.kickoff_utc.split("T")[0];
    const fixtures    = await fetchFixturesByDate(env, fixtureDate, dbFixture.stage);
    const match       = fixtures.find((f) => f.id === dbFixture.id);
    if (!match) return;
    if (match.espn_status === ESPN_STATUS.POST) {
      await updateFixtureStatus(env.DB, dbFixture.id, "FT");
    }
  } catch (err) {
    console.error(`checkIfFinished error for fixture ${dbFixture.id}:`, err);
    await logEvent(env.DB, "warn", `[live] checkIfFinished error for fixture ${dbFixture.id}: ${err.message}`);
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
  await logEvent(
    env.DB,
    "info",
    `[init] group stage initialized: ${all.length} fixtures stored, ${filtered.length} in schedule post`
  );
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
  await logEvent(env.DB, "info", `[daily] schedule posted for ${tomorrow}: ${fixtures.length} fixture(s)`);
}

// ─── Chat Commands ────────────────────────────────────────────────────────────
// Requires the GroupMe bot's "Callback URL" (set in dev.groupme.com) to point
// at this worker's /groupme-webhook path — see README for setup. Without a
// callback URL configured, GroupMe never calls this, and the bot behaves
// exactly as before (posts only, no listening).

/**
 * Entry point for GroupMe's message callback. GroupMe posts here for every
 * message sent in the group, including the bot's own — we filter those out
 * to avoid a feedback loop, then hand recognized commands off to a handler.
 * Unrecognized text is ignored silently so the bot doesn't spam the group
 * in response to ordinary conversation.
 */
async function handleGroupMeCallback(env, request) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return; // not valid JSON — ignore
  }

  // Ignore the bot's own posts and any system messages (joins/leaves/etc.)
  if (!body || body.sender_type !== "user" || body.system) return;

  const text = (body.text || "").trim();
  if (!text) return;

  try {
    await routeCommand(env, text);
  } catch (err) {
    console.error(`Command handling error for "${text}":`, err);
    await logEvent(env.DB, "error", `[command] error handling "${text}": ${err.message}`);
  }
}

/**
 * Matches the message against known commands. Anchored at the start of the
 * message (not "contains") so ordinary chat mentioning these words in a
 * sentence ("I live in Boston") doesn't accidentally trigger a reply.
 */
async function routeCommand(env, text) {
  const lower = text.trim().toLowerCase();
  let match;

  if ((match = lower.match(/^live\b\s*(.*)$/))) {
    return handleLiveCommand(env, match[1].trim());
  }
  if ((match = lower.match(/^stats\b\s*(.*)$/))) {
    return handleStatsCommand(env, match[1].trim());
  }
  if ((match = lower.match(/^goals\b\s*(.*)$/))) {
    return handleGoalsCommand(env, match[1].trim());
  }
  if (lower === "!help" || lower === "commands") {
    return postToGroupMe(env, formatCommandHelp());
  }
  // Not a recognized command — say nothing.
}

/**
 * Resolve which fixture a command should act on:
 *   - a search term given -> best matching fixture (active preferred over finished)
 *   - no term, exactly one live match -> that match
 *   - no term, multiple live matches -> ambiguous, let the caller ask for a team name
 *   - no term, nothing live -> most recently finished match
 */
async function resolveTargetFixture(env, term) {
  if (term) {
    const fixture = await findFixtureByTeam(env.DB, term);
    return { fixture, ambiguous: false };
  }
  const live = await getCurrentlyLiveFixtures(env.DB);
  if (live.length === 1) return { fixture: live[0], ambiguous: false };
  if (live.length > 1) return { fixture: null, ambiguous: true, candidates: live };
  const recent = await getMostRecentFinishedFixture(env.DB);
  return { fixture: recent, ambiguous: false };
}

/**
 * Get the current score (and, if live, status detail/clock) for a fixture.
 * For finished fixtures this reads the stored final score from D1. For
 * anything still in progress, it asks ESPN directly rather than trusting
 * any score cached in D1 — the live scoreboard is the only place with an
 * up-to-the-minute score and clock.
 */
async function getCurrentScore(env, fixture) {
  if (["FT", "AET", "PEN"].includes(fixture.status)) {
    return { homeScore: fixture.final_home_score, awayScore: fixture.final_away_score };
  }
  try {
    const live = await fetchLiveFixtures(env);
    const espnEvent = live.find((e) => parseInt(e.id, 10) === fixture.id);
    const comp = espnEvent?.competitions?.[0];
    const home = comp?.competitors?.find((c) => c.homeAway === "home");
    const away = comp?.competitors?.find((c) => c.homeAway === "away");
    const statusType = comp?.status?.type;
    return {
      homeScore: parseInt(home?.score || "0", 10),
      awayScore: parseInt(away?.score || "0", 10),
      statusDetail: statusType?.detail || statusType?.description || statusType?.shortDetail || "",
      clock: comp?.status?.displayClock || "",
    };
  } catch (err) {
    await logEvent(env.DB, "warn", `[command] live score fetch failed for fixture ${fixture.id}: ${err.message}`);
    return { homeScore: null, awayScore: null };
  }
}

async function handleLiveCommand(env, term) {
  const { fixture, ambiguous, candidates } = await resolveTargetFixture(env, term);
  if (ambiguous) {
    return postToGroupMe(env, formatAmbiguousReply(candidates, "live"));
  }
  if (!fixture) {
    return postToGroupMe(env, formatNoMatchReply(term));
  }
  if (["FT", "AET", "PEN"].includes(fixture.status)) {
    return postToGroupMe(env, formatFinishedReply(fixture));
  }
  const liveInfo = await getCurrentScore(env, fixture);
  await postToGroupMe(env, formatLiveReply(fixture, liveInfo));
}

async function handleStatsCommand(env, term) {
  const { fixture, ambiguous, candidates } = await resolveTargetFixture(env, term);
  if (ambiguous) {
    return postToGroupMe(env, formatAmbiguousReply(candidates, "stats"));
  }
  if (!fixture) {
    return postToGroupMe(env, formatNoMatchReply(term));
  }

  const score = await getCurrentScore(env, fixture);
  let stats = null;
  try {
    stats = await fetchStats(env, fixture.id);
  } catch (err) {
    await logEvent(env.DB, "warn", `[command] stats fetch failed for fixture ${fixture.id}: ${err.message}`);
  }
  await postToGroupMe(env, formatStatsReply(fixture, score.homeScore, score.awayScore, stats));
}

async function handleGoalsCommand(env, term) {
  const { fixture, ambiguous, candidates } = await resolveTargetFixture(env, term);
  if (ambiguous) {
    return postToGroupMe(env, formatAmbiguousReply(candidates, "goals"));
  }
  if (!fixture) {
    return postToGroupMe(env, formatNoMatchReply(term));
  }

  let plays;
  try {
    plays = await fetchEvents(env, fixture.id);
  } catch (err) {
    await logEvent(env.DB, "warn", `[command] goals fetch failed for fixture ${fixture.id}: ${err.message}`);
    return postToGroupMe(env, `Couldn't fetch goal data for ${fixture.home} vs ${fixture.away} right now — try again shortly.`);
  }
  const goalPlays = (plays || []).filter((p) => p.scoringPlay === true);
  await postToGroupMe(env, formatGoalsReply(fixture, goalPlays));
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
