/**
 * index.js — FIFA World Cup 2026 GroupMe Bot
 * Cloudflare Workers entry point
 *
 * Data source: ESPN unofficial API (no key required)
 */

import { fetchFixturesInRange, fetchFixturesByDate, fetchLiveFixtures, fetchEvents, fetchStats, ESPN_STATUS } from "./api.js";
import { postToGroupMe } from "./groupme.js";
import { formatGroupStageSchedule, formatDailySchedule, formatKickoff, formatHalfTime, formatFullTime, formatEvent } from "./formatter.js";
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

// ─── ESPN status → our internal DB status mapping ────────────────────────────
// ESPN uses state: "pre" | "in" | "post"
// We store: "NS" | "LIVE" | "HT" | "FT"
// Half-time is detected via status.type.name === "STATUS_HALFTIME"

// ─── Cron Entry Point ─────────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "* * * * *") {
      ctx.waitUntil(runLivePolling(env));
    } else if (event.cron === "0 8 * * *") {
      ctx.waitUntil(runDailyJob(env));
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
    if (action === "reset_fixture") {
      const id = url.searchParams.get("id");
      if (!id) return new Response("Missing ?id=", { status: 400 });
      await env.DB.prepare("DELETE FROM seen_events WHERE fixture_id = ?").bind(id).run();
      await env.DB.prepare("UPDATE fixtures SET status = 'NS' WHERE id = ?").bind(id).run();
      return new Response(`Fixture ${id} reset.`);
    }

    return new Response(
      " WC2026 Bot running.\n\n" +
      "Manual triggers (GET):\n" +
      "  ?action=init                  — One-time: load group stage fixtures + post schedule\n" +
      "  ?action=daily                 — Run daily job now (post tomorrow's schedule)\n" +
      "  ?action=live                  — Run live polling now\n" +
      "  ?action=reset_fixture&id=ID   — Reset a fixture state for retesting\n"
    );
  },
};

// ─── Initialization (run once via ?action=init) ───────────────────────────────

async function initGroupStage(env) {
  const already = await getState(env.DB, "group_schedule_posted");
  if (already === "1") {
    console.log("Group stage already initialized.");
    return;
  }

  console.log("Fetching group stage fixtures from ESPN...");

  // ESPN can fetch the entire group stage in one request via date range
  const all = await fetchFixturesInRange(env, GROUP_STAGE_START, GROUP_STAGE_END, "group");

  // Filter for GroupMe post (only followed countries), but store all in D1
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

  // During group stage: ensure init happened (safety net)
  if (today <= GROUP_STAGE_END) {
    const initialized = await getState(env.DB, "group_schedule_posted");
    if (!initialized) await initGroupStage(env);
    return; // No daily schedule posts during group stage
  }

  // Knockout stage: post tomorrow's schedule
  const stateKey     = `daily_schedule_${tomorrow}`;
  const alreadyPosted = await getState(env.DB, stateKey);
  if (alreadyPosted === "1" && !force) return;

  const raw = await fetchFixturesByDate(env, tomorrow, "knockout");
  await upsertFixtures(env.DB, raw);

  const fixtures = await getFixturesByDate(env.DB, tomorrow);
  const label    = `Tomorrow — ${readableDate(tomorrow)}`;
  const msg      = formatDailySchedule(fixtures, label);
  await postToGroupMe(env, msg);
  await setState(env.DB, stateKey, "1");
  console.log(`Daily schedule posted for ${tomorrow}: ${fixtures.length} fixtures.`);
}

// ─── Live Polling (every 1 minute) ───────────────────────────────────────────

async function runLivePolling(env) {
  // Check D1 first — any fixtures that should be active right now?
  const activeInDb = await getActiveFixtures(env.DB);
  if (activeInDb.length === 0) return; // Nothing active — exit fast, zero API calls

  // Fetch today's full scoreboard from ESPN (includes live status + scores)
  let liveEvents;
  try {
    liveEvents = await fetchLiveFixtures(env);
  } catch (err) {
    console.error("Failed to fetch live fixtures from ESPN:", err);
    return;
  }

  // Map by ESPN event ID for quick lookup
  const liveById = new Map(liveEvents.map((e) => [parseInt(e.id, 10), e]));

  for (const dbFixture of activeInDb) {
    const espnEvent = liveById.get(dbFixture.id);

    if (!espnEvent) {
      // Not in live feed — may have just finished
      await checkIfFinished(env, dbFixture);
      continue;
    }

    await processLiveFixture(env, dbFixture, espnEvent);
  }
}

async function processLiveFixture(env, dbFixture, espnEvent) {
  const comp       = espnEvent.competitions?.[0];
  const statusType = comp?.status?.type;
  const state      = statusType?.state;       // "pre" | "in" | "post"
  const statusName = statusType?.name || "";  // e.g. "STATUS_HALFTIME", "STATUS_IN_PROGRESS"
  const prevStatus = dbFixture.status;

  const home = comp?.competitors?.find((c) => c.homeAway === "home");
  const away = comp?.competitors?.find((c) => c.homeAway === "away");
  const homeScore = parseInt(home?.score || "0", 10);
  const awayScore = parseInt(away?.score || "0", 10);

  // ── Kickoff: transition from NS → in progress
  if (prevStatus === "NS" && state === ESPN_STATUS.IN && statusName !== "STATUS_HALFTIME") {
    await postToGroupMe(env, formatKickoff(dbFixture));
    await updateFixtureStatus(env.DB, dbFixture.id, "LIVE");
  }

  // ── Half time
  if (statusName === "STATUS_HALFTIME" && prevStatus !== "HT") {
    await postToGroupMe(env, formatHalfTime(dbFixture, homeScore, awayScore));
    await updateFixtureStatus(env.DB, dbFixture.id, "HT");
    return; // Don't poll events during HT
  }

  // ── Full time / extra time finished
  if (state === ESPN_STATUS.POST && !["FT", "AET", "PEN"].includes(prevStatus)) {
    const ftStatus = deriveFullTimeStatus(statusName);
    await handleMatchEnd(env, dbFixture, espnEvent, homeScore, awayScore, ftStatus);
    return;
  }

  // ── Live events during play
  if (state === ESPN_STATUS.IN && statusName !== "STATUS_HALFTIME") {
    await updateFixtureStatus(env.DB, dbFixture.id, "LIVE");
    await pollAndPostEvents(env, dbFixture, homeScore, awayScore);
  }
}

async function pollAndPostEvents(env, dbFixture, homeScore, awayScore) {
  let plays;
  try {
    plays = await fetchEvents(env, dbFixture.id);
  } catch (err) {
    console.error(`Failed to fetch plays for fixture ${dbFixture.id}:`, err);
    return;
  }
  if (!plays || plays.length === 0) return;

  const seen = await getSeenEvents(env.DB, dbFixture.id);

  // ESPN plays — only post key event types
  const KEY_TYPES = ["goal", "yellow card", "red card", "substitution", "var"];

  for (const play of plays) {
    const typeText = (play.type?.text || "").toLowerCase();
    if (!KEY_TYPES.some((t) => typeText.includes(t))) continue;

    // Unique key: clock value + type + athlete id
    const athleteId = play.participants?.[0]?.athlete?.id || "x";
    const clock     = play.clock?.value || play.clock?.displayValue || "0";
    const key       = `${clock}_${typeText}_${athleteId}`;

    if (seen.has(key)) continue;

    const msg = formatEvent(play, dbFixture, homeScore, awayScore);
    if (msg) await postToGroupMe(env, msg);
    await insertSeenEvent(env.DB, dbFixture.id, key);
  }
}

async function handleMatchEnd(env, dbFixture, espnEvent, homeScore, awayScore, ftStatus) {
  let stats = null;
  try {
    stats = await fetchStats(env, dbFixture.id);
  } catch (err) {
    console.error(`Could not fetch stats for ${dbFixture.id}:`, err);
  }

  const msg = formatFullTime(dbFixture, homeScore, awayScore, stats, ftStatus);
  await postToGroupMe(env, msg);
  await updateFixtureStatus(env.DB, dbFixture.id, ftStatus);
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
      console.log(`Fixture ${dbFixture.id} marked FT via fallback check.`);
    }
  } catch (err) {
    console.error(`checkIfFinished error for fixture ${dbFixture.id}:`, err);
  }
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
    weekday: "long",
    month:   "long",
    day:     "numeric",
    timeZone: "UTC",
  });
}