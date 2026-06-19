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
import { formatGroupStageSchedule, formatDailySchedule, formatKickoff, formatHalfTime, formatFullTime, formatEvent, formatGenericGoal } from "./formatter.js";
import { upsertFixtures, getFixturesByDate, getActiveFixtures, updateFixtureStatus, getSeenEvents, insertSeenEvent, getState, setState } from "./db.js";

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
      await env.DB.prepare("UPDATE fixtures SET status = 'NS' WHERE id = ?").bind(id).run();
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

  // The hourly check is the ONLY place that decides whether game_imminent
  // is on or off. The minute poll never turns this flag off itself — it
  // would risk falsely going to sleep mid-match due to a transient DB read
  // or a status update that hadn't landed yet (race condition). Letting
  // only the hourly check own this flag means a single bad minute-poll
  // read can never put the bot to sleep during a live match.
  const activeOrUpcoming = await getActiveFixtures(env.DB);
  const today    = utcDate(0);
  const fixtures = await getFixturesByDate(env.DB, today);
  const now      = Date.now();

  // A game is "imminent" if it kicks off within the next 70 minutes,
  // OR if getActiveFixtures (status-based, not time-window-based) says
  // it's still in progress right now.
  const upcomingSoon = fixtures.some((f) => {
    const kickoff   = new Date(f.kickoff_utc).getTime();
    const minsUntil = (kickoff - now) / 60000;
    return minsUntil >= 0 && minsUntil <= 70;
  });

  const imminent = upcomingSoon || activeOrUpcoming.length > 0;

  await env.KV.put(KV_GAME_IMMINENT, imminent ? "1" : "0", {
    expirationTtl: 60 * 60 * 2,
  });
  console.log(`Hourly check: game_imminent=${imminent}`);
}

// ─── Minute Poll ──────────────────────────────────────────────────────────────
// Runs every minute. Exits immediately if game_imminent is not set.
// IMPORTANT: this function only ever does work — it never clears the
// game_imminent flag itself. Only runHourlyCheck decides when to sleep.
// This avoids a race where a single bad/early getActiveFixtures read
// during the minute poll could prematurely put the bot to sleep mid-match.

async function runMinutePoll(env) {
  const imminent = await env.KV.get(KV_GAME_IMMINENT);
  if (imminent !== "1") return; // Exit instantly — no game imminent

  await runLivePolling(env);
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
  // Status is updated BEFORE posting, not after. If postToGroupMe fails
  // (GroupMe API down/rate-limited), we'd rather silently miss one kickoff
  // message than spam "KICK OFF" every minute until the call succeeds.
  if (prevStatus === "NS" && state === ESPN_STATUS.IN && statusName !== "STATUS_HALFTIME") {
    await updateFixtureStatus(env.DB, dbFixture.id, "LIVE");
    await postToGroupMe(env, formatKickoff(dbFixture));
    return;
  }

  // Half time — same ordering rationale as kickoff above.
  if (statusName === "STATUS_HALFTIME" && prevStatus !== "HT") {
    await updateFixtureStatus(env.DB, dbFixture.id, "HT");
    let htStats = null;
    try {
      htStats = await fetchStats(env, dbFixture.id);
    } catch (err) {
      console.error(`Could not fetch HT stats for ${dbFixture.id}:`, err);
    }
    await postToGroupMe(env, formatHalfTime(dbFixture, homeScore, awayScore, htStats));
    return;
  }

  // Second half resumes after HT
  if (prevStatus === "HT" && state === ESPN_STATUS.IN && statusName !== "STATUS_HALFTIME") {
    await updateFixtureStatus(env.DB, dbFixture.id, "LIVE");
  }

  // Full time — handleMatchEnd itself updates status before posting (see below)
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

  // Score changed since last seen — find which goal play matches this score
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

  // Post the most recent goal play (last one in the array is most recent)
  const latestGoal = goalPlays[goalPlays.length - 1];
  const msg = latestGoal
    ? formatEvent(latestGoal, dbFixture, homeScore, awayScore)
    : formatGenericGoal(dbFixture, homeScore, awayScore);

  // Record before posting — same rationale as kickoff/HT/FT: a failed
  // postToGroupMe call should mean we silently miss one goal announcement,
  // not that we re-announce the same goal every minute until it succeeds.
  await insertSeenEvent(env.DB, dbFixture.id, scoreKey);
  if (msg) await postToGroupMe(env, msg);
}

async function handleMatchEnd(env, dbFixture, espnEvent, homeScore, awayScore, ftStatus) {
  let stats = null;
  try {
    stats = await fetchStats(env, dbFixture.id);
  } catch (err) {
    console.error(`Could not fetch stats for ${dbFixture.id}:`, err);
  }

  // Status updated before posting — same rationale as kickoff/half-time:
  // avoids spamming "FULL TIME" every minute if postToGroupMe fails once.
  await updateFixtureStatus(env.DB, dbFixture.id, ftStatus);
  const msg = formatFullTime(dbFixture, homeScore, awayScore, stats, ftStatus);
  await postToGroupMe(env, msg);
  console.log(`Match ended: ${dbFixture.home} ${homeScore}-${awayScore} ${dbFixture.away} (${ftStatus})`);
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