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

import {
  fetchFixturesInRange,
  fetchFixturesPadded,
  fetchScoreboardEvents,
  fetchEvents,
  fetchStats,
  ESPN_STATUS,
} from "./api.js";
import { postToGroupMe } from "./groupme.js";
import {
  formatGroupStageSchedule,
  formatDailySchedule,
  formatKickoff,
  formatSecondHalfKickoff,
  formatPhaseTransition,
  formatHalfTime,
  formatFullTime,
  formatFinalStatsFollowUp,
  formatEvent,
  formatGenericGoal,
} from "./formatter.js";
import {
  upsertFixtures,
  getFixturesByDate,
  getActiveFixtures,
  getFixturesPendingStats,
  updateFixtureStatus,
  markStatsPending,
  clearStatsPending,
  setFinalScore,
  resetFixtureState,
  getSeenEvents,
  insertSeenEvent,
  getState,
  setState,
  logEvent,
  trimEventLog,
} from "./db.js";
import { handleAdminRequest } from "./admin.js";
import { routeCommand, getEffectiveFollowedTeams } from "./commands.js";

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
const MUTE_KV_KEY        = "muted_until";

const FT_STATS_MAX_RETRIES = 5;

const JOB_FNS = {
  runDailyJob,
  runHourlyCheck,
  runMidnightCheck,
  runLivePolling,
};

// ─── Cron / Fetch Entry Point ─────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron;

    if (cron === "0 0 * * *") {
      ctx.waitUntil(runMidnightCheck(env));
      ctx.waitUntil(trimEventLog(env.DB, 500));
    } else if (cron === "0 8 * * *") {
      ctx.waitUntil(runDailyJob(env));
    } else if (cron === "0 * * * *") {
      ctx.waitUntil(runHourlyCheck(env));
    } else if (cron === "* * * * *") {
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
      let body = null;
      try {
        body = await request.json();
      } catch (err) {
        await logEvent(env.DB, "warn", `[command] webhook body was not valid JSON: ${err.message}`);
      }
      ctx.waitUntil(handleGroupMeCallback(env, body));
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
      await resetFixtureState(env.DB, id);
      await logEvent(env.DB, "info", `[action=reset_fixture] fixture ${id} fully reset to NS`);
      return new Response(`Fixture ${id} reset.`);
    }
    if (action === "status") {
      const gamesToday   = await env.KV.get(KV_GAMES_TODAY);
      const gameImminent = await env.KV.get(KV_GAME_IMMINENT);
      return new Response(`games_today=${gamesToday}\ngame_imminent=${gameImminent}`);
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

  const relevant = today <= GROUP_STAGE_END
    ? await filterFixtures(env, fixtures, "group")
    : fixtures;

  const hasGames = relevant.length > 0;
  await env.KV.put(KV_GAMES_TODAY, hasGames ? "1" : "0", { expirationTtl: 60 * 60 * 26 });
  await env.KV.put(KV_GAME_IMMINENT, "0", { expirationTtl: 60 * 60 * 26 });

  console.log(`Midnight check: games_today=${hasGames}, ${relevant.length} fixtures found.`);
  await logEvent(env.DB, "info", `[midnight] games_today=${hasGames} (${relevant.length} fixture(s) found for ${today})`);
}

// ─── Hourly Check ─────────────────────────────────────────────────────────────
// Runs every hour. Only does work if games_today=1.
// Checks D1 (not ESPN) for a fixture kicking off within ~70 min, or already
// underway. See api.js header comment: ESPN's own dates= scoreboard param
// buckets games by its own match-day convention, not UTC midnight, so
// re-fetching "today" from ESPN here can silently miss a fixture that our
// own D1 storage correctly has as "today" in UTC terms. D1's kickoff_utc
// column doesn't have that problem, so we use it directly instead.

async function runHourlyCheck(env) {
  const gamesToday = await env.KV.get(KV_GAMES_TODAY);
  if (gamesToday !== "1") {
    console.log("Hourly check: no games today, skipping.");
    return;
  }

  const today     = utcDate(0);
  const yesterday = utcDate(-1);

  // Check both UTC-day buckets: a fixture that just rolled across the UTC
  // day boundary (e.g. kickoff 01:00 UTC) is stored under "today", but a
  // fixture from "yesterday" that's running long (extra time, delays) is
  // still worth checking too.
  const [todayFixtures, yesterdayFixtures] = await Promise.all([
    getFixturesByDate(env.DB, today),
    getFixturesByDate(env.DB, yesterday),
  ]);
  const candidates = [...yesterdayFixtures, ...todayFixtures].filter(
    (f) => !["FT", "AET", "PEN"].includes(f.status)
  );

  const relevant = today <= GROUP_STAGE_END
    ? await filterFixtures(env, candidates, "group")
    : candidates;

  const now = Date.now();
  const imminent = relevant.some((f) => {
    const kickoff   = new Date(f.kickoff_utc).getTime();
    const minsUntil = (kickoff - now) / 60000;
    if (minsUntil >= 0 && minsUntil <= 70) return true;
    const minsAgo = (now - kickoff) / 60000;
    // Bounded to 5 hours so a genuinely stuck/stale fixture (see the
    // reconcile job) doesn't keep this flag pinned true forever and burn
    // Cloudflare subrequests on every minute cron indefinitely.
    return minsAgo >= 0 && minsAgo <= 300;
  });

  await env.KV.put(KV_GAME_IMMINENT, imminent ? "1" : "0", { expirationTtl: 60 * 60 * 2 });
  console.log(`Hourly check: game_imminent=${imminent} (source: D1 fixtures, kickoff-time math)`);
  await logEvent(env.DB, "info", `[hourly] game_imminent=${imminent} (source: D1 fixtures, kickoff-time math)`);
}

// ─── Minute Poll ──────────────────────────────────────────────────────────────

async function runMinutePoll(env) {
  const imminent = await env.KV.get(KV_GAME_IMMINENT);
  if (imminent !== "1") return;

  await runLivePolling(env);
  await runStatsRetry(env);

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

  // Use fetchScoreboardEvents (unfiltered — includes pre/in/post) rather
  // than the old state==="in"-only fetch. Filtering to "in" meant a fixture
  // that just flipped to "post" vanished from this map on the very next
  // poll, before processLiveFixture() got a chance to see the transition
  // and post FULL TIME / store the final score / queue a stats retry —
  // it fell through to checkIfFinished() instead, which used to just set
  // status='FT' silently with none of that.
  let scoreboardEvents;
  try {
    scoreboardEvents = await fetchScoreboardEvents(env);
  } catch (err) {
    console.error("Failed to fetch scoreboard from ESPN:", err);
    await logEvent(env.DB, "error", `[live] failed to fetch scoreboard from ESPN: ${err.message}`);
    return;
  }

  const eventsById = new Map(scoreboardEvents.map((e) => [parseInt(e.id, 10), e]));

  for (const dbFixture of activeInDb) {
    const espnEvent = eventsById.get(dbFixture.id);
    if (!espnEvent) {
      // Not on ESPN's default (dateless) scoreboard at all — this can still
      // happen for the same date-bucketing reason (ESPN's bare scoreboard
      // also defaults to its own "today"). Fall back to a padded date fetch
      // so we can still detect and fully finalize a finished match.
      await checkIfFinished(env, dbFixture);
      continue;
    }
    await processLiveFixture(env, dbFixture, espnEvent);
  }
}

async function processLiveFixture(env, dbFixture, espnEvent) {
  const comp         = espnEvent.competitions?.[0];
  const statusType   = comp?.status?.type;
  const state        = statusType?.state;
  const statusName   = statusType?.name || "";
  const statusDetail = statusType?.detail || statusType?.description || statusType?.shortDetail || "";
  const period        = comp?.status?.period ?? null;
  const prevStatus    = dbFixture.status;

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

async function checkExtraTimePhases(env, dbFixture, statusName, statusDetail, period, homeScore, awayScore) {
  const name   = (statusName || "").toUpperCase();
  const detail = (statusDetail || "").toLowerCase();

  const looksShootout = name.includes("SHOOTOUT") || detail.includes("shootout") || detail.includes("penalty shoot");
  const looksExtra = !looksShootout && (
    name.includes("EXTRA") || name.includes("_ET") || detail.includes("extra time") ||
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
  if (last === phase) return;
  await setState(env.DB, key, phase);

  await logRawShapeOnce(env, `extra_time_shape_${dbFixture.id}`, "status_object", { statusName, statusDetail, period });

  const msg = formatPhaseTransition(phase, dbFixture, homeScore, awayScore);
  if (msg) {
    await postToGroupMe(env, msg);
    await logEvent(env.DB, "info", `[live] phase transition posted: ${phase} for fixture ${dbFixture.id} (${dbFixture.home} vs ${dbFixture.away})`);
  }
}

async function pollAndPostEvents(env, dbFixture, homeScore, awayScore) {
  const seen = await getSeenEvents(env.DB, dbFixture.id);
  const scoreKey = `score_${homeScore}_${awayScore}`;

  if (seen.has(scoreKey)) return;
  if (homeScore === 0 && awayScore === 0) {
    await insertSeenEvent(env.DB, dbFixture.id, scoreKey);
    return;
  }

  let plays;
  try {
    plays = await fetchEvents(env, dbFixture.id);
  } catch (err) {
    console.error(`Failed to fetch plays for fixture ${dbFixture.id}:`, err);
    await logEvent(env.DB, "warn", `[live] failed to fetch plays for fixture ${dbFixture.id}: ${err.message}`);
    await insertSeenEvent(env.DB, dbFixture.id, scoreKey);
    return;
  }

  const goalPlays = (plays || []).filter((p) => p.scoringPlay === true);
  await logRawShapeOnce(env, `goal_play_shape_v2_${dbFixture.id}`, "goal_play", goalPlays[0] || plays[0]);

  const matchingGoal = findGoalMatchingScore(goalPlays, homeScore, awayScore);
  const latestGoal   = matchingGoal || goalPlays[goalPlays.length - 1];

  const totalGoalsImplied = homeScore + awayScore;
  const feedLooksStale    = !matchingGoal && goalPlays.length < totalGoalsImplied;

  const msg = !feedLooksStale && latestGoal
    ? formatEvent(latestGoal, dbFixture, homeScore, awayScore)
    : formatGenericGoal(dbFixture, homeScore, awayScore);

  if (msg) await postToGroupMe(env, msg);
  await insertSeenEvent(env.DB, dbFixture.id, scoreKey);
  await logEvent(env.DB, "info", `[live] goal posted: ${dbFixture.home} ${homeScore}-${awayScore} ${dbFixture.away}`);
}

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
  await logRawShapeOnce(env, `stats_shape_${dbFixture.id}`, "boxscore_team", stats?.[0]);

  const { winner, shootout } = extractWinnerAndShootout(espnEvent, homeScore, awayScore);

  await updateFixtureStatus(env.DB, dbFixture.id, ftStatus);
  await setFinalScore(env.DB, dbFixture.id, homeScore, awayScore);

  const msg = formatFullTime(dbFixture, homeScore, awayScore, stats, ftStatus, shootout, winner);
  await postToGroupMe(env, msg);

  if (!stats || stats.length < 2) {
    await markStatsPending(env.DB, dbFixture.id);
    console.log(`FT stats not ready yet for fixture ${dbFixture.id} — will retry.`);
    await logEvent(env.DB, "info", `[live] FT stats not ready for fixture ${dbFixture.id} — queued for retry`);
  }

  console.log(`Match ended: ${dbFixture.home} ${homeScore}-${awayScore} ${dbFixture.away} (${ftStatus})`);
  await logEvent(env.DB, "info", `[live] match ended: ${dbFixture.home} ${homeScore}-${awayScore} ${dbFixture.away} (${ftStatus})`);
}

/**
 * Derive winner + shootout score from a raw ESPN event's competitor objects.
 * espnEvent can be null (e.g. when finalizing via the padded-date fallback
 * path, which only has normalized fixture data, not the raw scoreboard
 * event) — in that case we just return {winner: null, shootout: null} and
 * formatFullTime() falls back to comparing homeScore/awayScore directly,
 * which is still correct, just without the explicit shootout score line.
 */
function extractWinnerAndShootout(espnEvent, homeScore, awayScore) {
  const comp = espnEvent?.competitions?.[0];
  const home = comp?.competitors?.find((c) => c.homeAway === "home");
  const away = comp?.competitors?.find((c) => c.homeAway === "away");

  let winner = null;
  if (home?.winner === true) winner = "home";
  else if (away?.winner === true) winner = "away";
  else if (home?.winner === false && away?.winner === false) winner = "draw";

  let shootout = null;
  const homeShootout = home?.shootoutScore ?? home?.penaltyScore ?? home?.score?.shootout;
  const awayShootout = away?.shootoutScore ?? away?.penaltyScore ?? away?.score?.shootout;
  if (homeShootout != null && awayShootout != null) {
    shootout = { home: parseInt(homeShootout, 10), away: parseInt(awayShootout, 10) };
  }

  return { winner, shootout };
}

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
      const msg = formatFinalStatsFollowUp(fixture, fixture.final_home_score, fixture.final_away_score, stats);
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

async function logRawShapeOnce(env, stateKey, label, payload) {
  if (!payload) return;
  const already = await getState(env.DB, stateKey);
  if (already === "1") return;
  await setState(env.DB, stateKey, "1");
  const json = JSON.stringify(payload);
  const truncated = json.length > 4000 ? json.slice(0, 4000) + "...[truncated]" : json;
  await logEvent(env.DB, "debug", `[shape-capture:${label}] ${truncated}`);
  console.log(`[shape-capture:${label}]`, json);
}

/**
 * Fallback for when an active D1 fixture doesn't show up in ESPN's default
 * scoreboard at all (fetchScoreboardEvents). This now fully finalizes the
 * match — posts FULL TIME, stores final score, queues a stats retry if
 * needed — instead of silently setting status='FT' with none of that.
 *
 * Uses fetchFixturesPadded (±1 day around the fixture's own kickoff date)
 * rather than an exact-date fetch, for the same ESPN date-bucketing reason
 * documented in api.js. We don't have the raw ESPN event here (only the
 * normalized fixture), so extractWinnerAndShootout() gets `null` and falls
 * back to comparing homeScore/awayScore — correct, just without an explicit
 * shootout score line if this was a penalty-shootout finish.
 */
async function checkIfFinished(env, dbFixture) {
  try {
    const fixtureDate = dbFixture.kickoff_utc.split("T")[0];
    const fixtures = await fetchFixturesPadded(env, fixtureDate, dbFixture.stage);
    const match = fixtures.find((f) => f.id === dbFixture.id);
    if (!match) return;

    if (match.espn_status === ESPN_STATUS.POST) {
      const ftStatus = deriveFullTimeStatus(match.espn_status_name);
      await handleMatchEnd(env, dbFixture, null, match.home_score, match.away_score, ftStatus);
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
  const filtered = await filterFixtures(env, all, "group");

  await upsertFixtures(env.DB, all);

  const msg = formatGroupStageSchedule(filtered, FOLLOWED_COUNTRIES !== null, FOLLOWED_COUNTRIES || []);
  await postToGroupMe(env, msg);
  await setState(env.DB, "group_schedule_posted", "1");
  console.log(`Group stage initialized. ${all.length} fixtures stored, ${filtered.length} in schedule post.`);
  await logEvent(env.DB, "info", `[init] group stage initialized: ${all.length} fixtures stored, ${filtered.length} in schedule post`);
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

  // Padded fetch: an early-UTC-morning kickoff on "tomorrow" can be bucketed
  // by ESPN under "today" (see api.js header comment), so an exact-date
  // fetch for `tomorrow` could miss it and leave it out of the schedule post.
  const raw = await fetchFixturesPadded(env, tomorrow, "knockout");
  await upsertFixtures(env.DB, raw);

  const fixtures = await getFixturesByDate(env.DB, tomorrow);
  const label    = `Tomorrow - ${readableDate(tomorrow)}`;
  const msg      = formatDailySchedule(fixtures, label);
  await postToGroupMe(env, msg);
  await setState(env.DB, stateKey, "1");
  console.log(`Daily schedule posted for ${tomorrow}: ${fixtures.length} fixtures.`);
  await logEvent(env.DB, "info", `[daily] schedule posted for ${tomorrow}: ${fixtures.length} fixture(s)`);
}

// ─── GroupMe Webhook ──────────────────────────────────────────────────────────

async function handleGroupMeCallback(env, body) {
  if (body === null) return;
  if (!body || body.sender_type !== "user" || body.system) {
    await logEvent(env.DB, "debug", `[command] ignored callback: sender_type=${body?.sender_type} system=${body?.system}`);
    return;
  }
  const text = (body.text || "").trim();
  if (!text) return;

  await logEvent(env.DB, "debug", `[command] received: "${text}"`);
  try {
    const handled = await routeCommand(env, body, JOB_FNS);
    await logEvent(env.DB, "info", `[command] "${text}" -> ${handled ? "handled" : "no match, ignored"}`);
  } catch (err) {
    console.error(`Command handling error for "${text}":`, err);
    await logEvent(env.DB, "error", `[command] error handling "${text}": ${err.message}`);
  }
}

// ─── Country Filter ───────────────────────────────────────────────────────────

async function filterFixtures(env, fixtures, stage) {
  if (stage === "knockout") return fixtures;
  const staticList = FOLLOWED_COUNTRIES || [];
  const effective  = await getEffectiveFollowedTeams(env, staticList);
  if (effective.length === 0) return fixtures;
  const set = new Set(effective.map((c) => c.toLowerCase()));
  return fixtures.filter((f) => set.has(f.home.toLowerCase()) || set.has(f.away.toLowerCase()));
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
