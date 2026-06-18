/**
 * index.js — FIFA World Cup 2026 GroupMe Bot
 * Cloudflare Workers entry point
 */

import { fetchFixturesInRange, fetchFixturesByDate, fetchLiveFixtures, fetchEvents, fetchStats } from "./api.js";
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
const GROUP_STAGE_START  = "2026-06-11";
const GROUP_STAGE_END    = "2026-06-26";
const KNOCKOUT_START     = "2026-06-28"; // Round of 32 begins

// ─── Cron Entry Point ─────────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "* * * * *") {
      ctx.waitUntil(runLivePolling(env));
    } else if (event.cron === "0 8 * * *") {
      ctx.waitUntil(runDailyJob(env));
    }
  },

  // Manual HTTP trigger for testing/setup
  async fetch(request, env) {
    const url  = new URL(request.url);
    const action = url.searchParams.get("action");

    if (action === "init") {
      // One-time setup: fetch & store full group stage, post schedule
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
      "⚽ WC2026 Bot running.\n\n" +
      "Manual triggers (GET):\n" +
      "  ?action=init            — One-time: load group stage fixtures + post schedule\n" +
      "  ?action=daily           — Run daily job now (tomorrow's schedule)\n" +
      "  ?action=live            — Run live polling now\n" +
      "  ?action=reset_fixture&id=ID  — Reset a fixture state for retesting\n"
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

  console.log("Fetching group stage fixtures...");
  const all = await fetchFixturesInRange(env, GROUP_STAGE_START, GROUP_STAGE_END, "group");

  // Apply country filter if active
  const filtered = filterFixtures(all, "group");

  // Store ALL group stage fixtures in D1 (even non-followed ones — for completeness)
  // But only post the filtered ones in the schedule message
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
  const today = utcDate(0);
  const tomorrow = utcDate(1);

  // If we're still in group stage, ensure group stage is initialized
  if (today <= GROUP_STAGE_END) {
    const initialized = await getState(env.DB, "group_schedule_posted");
    if (!initialized) {
      await initGroupStage(env);
    }
    return; // No daily schedule posts during group stage
  }

  // Knockout stage: post tomorrow's schedule daily
  const stateKey = `daily_schedule_${tomorrow}`;
  const alreadyPosted = await getState(env.DB, stateKey);
  if (alreadyPosted === "1" && !force) return;

  // Fetch & store tomorrow's fixtures
  const raw = await fetchFixturesByDate(env, tomorrow, "knockout");
  await upsertFixtures(env.DB, raw);

  // All knockout games — no filter
  const fixtures = await getFixturesByDate(env.DB, tomorrow);

  const label = `Tomorrow — ${readableDate(tomorrow)}`;
  const msg = formatDailySchedule(fixtures, label);
  await postToGroupMe(env, msg);
  await setState(env.DB, stateKey, "1");
  console.log(`Daily schedule posted for ${tomorrow}: ${fixtures.length} fixtures.`);
}

// ─── Live Polling (every 1 minute) ───────────────────────────────────────────

async function runLivePolling(env) {
  // First check D1 — do we have any fixtures that should be active right now?
  const activeInDb = await getActiveFixtures(env.DB);

  if (activeInDb.length === 0) {
    // No active fixtures in DB — exit immediately, no API call needed
    return;
  }

  // There are expected-active fixtures — hit the API
  let liveFromApi;
  try {
    liveFromApi = await fetchLiveFixtures(env);
  } catch (err) {
    console.error("Failed to fetch live fixtures:", err);
    return;
  }

  const liveById = new Map((liveFromApi || []).map((f) => [f.fixture.id, f]));

  for (const dbFixture of activeInDb) {
    const apiFixture = liveById.get(dbFixture.id);

    if (!apiFixture) {
      // Not in live feed — may have just finished; check via today's fixture list
      await checkIfFinished(env, dbFixture);
      continue;
    }

    await processLiveFixture(env, dbFixture, apiFixture);
  }
}

async function processLiveFixture(env, dbFixture, apiFixture) {
  const status = apiFixture.fixture.status.short;
  const prevStatus = dbFixture.status;
  const homeScore = apiFixture.goals.home ?? 0;
  const awayScore = apiFixture.goals.away ?? 0;

  // Kickoff
  if (prevStatus === "NS" && ["1H", "2H", "ET"].includes(status)) {
    await postToGroupMe(env, formatKickoff(dbFixture));
    await updateFixtureStatus(env.DB, dbFixture.id, status);
  }

  // Half time
  if (status === "HT" && prevStatus !== "HT") {
    await postToGroupMe(env, formatHalfTime(dbFixture, homeScore, awayScore));
    await updateFixtureStatus(env.DB, dbFixture.id, "HT");
  }

  // Full time / AET / Penalties
  if (["FT", "AET", "PEN"].includes(status) && !["FT", "AET", "PEN"].includes(prevStatus)) {
    await handleMatchEnd(env, dbFixture, apiFixture, status);
    return;
  }

  // Live events during play
  if (["1H", "2H", "ET", "P"].includes(status)) {
    await updateFixtureStatus(env.DB, dbFixture.id, status);
    await pollAndPostEvents(env, dbFixture, apiFixture, homeScore, awayScore);
  }
}

async function pollAndPostEvents(env, dbFixture, apiFixture, homeScore, awayScore) {
  let events;
  try {
    events = await fetchEvents(env, dbFixture.id);
  } catch (err) {
    console.error(`Failed to fetch events for fixture ${dbFixture.id}:`, err);
    return;
  }
  if (!events || events.length === 0) return;

  const seen = await getSeenEvents(env.DB, dbFixture.id);

  for (const event of events) {
    const key = `${event.time.elapsed}${event.time.extra || ""}_${event.type}_${event.player?.id ?? "x"}`;
    if (seen.has(key)) continue;

    const msg = formatEvent(event, dbFixture, homeScore, awayScore);
    if (msg) {
      await postToGroupMe(env, msg);
    }
    await insertSeenEvent(env.DB, dbFixture.id, key);
  }
}

async function handleMatchEnd(env, dbFixture, apiFixture, status) {
  const homeScore = apiFixture.goals.home ?? 0;
  const awayScore = apiFixture.goals.away ?? 0;

  let stats = null;
  try {
    stats = await fetchStats(env, dbFixture.id);
  } catch (err) {
    console.error(`Could not fetch stats for ${dbFixture.id}:`, err);
  }

  const msg = formatFullTime(dbFixture, homeScore, awayScore, stats, status);
  await postToGroupMe(env, msg);
  await updateFixtureStatus(env.DB, dbFixture.id, status);
  console.log(`Match ended: ${dbFixture.home} ${homeScore}-${awayScore} ${dbFixture.away} (${status})`);
}

async function checkIfFinished(env, dbFixture) {
  // Fixture was expected-active but not in live feed — fetch today's list to confirm status
  try {
    const today = utcDate(0);
    const todayFixtures = await fetchFixturesByDate(env, today, dbFixture.stage);
    const match = todayFixtures.find((f) => f.id === dbFixture.id);
    if (!match) return;

    // We need the raw API fixture for scores/stats — re-fetch today's raw list
    // (fetchFixturesByDate returns normalized objects; for scores we need the raw response)
    // As a lightweight alternative: if status maps to FT/AET/PEN, mark it done
    // The full-time post will have already fired in the previous cycle when it was still live
    const finishedStatuses = ["FT", "AET", "PEN"];
    if (finishedStatuses.includes(match.status)) {
      await updateFixtureStatus(env.DB, dbFixture.id, match.status);
    }
  } catch (err) {
    console.error(`checkIfFinished error for fixture ${dbFixture.id}:`, err);
  }
}

// ─── Country Filter ───────────────────────────────────────────────────────────

function filterFixtures(fixtures, stage) {
  if (stage === "knockout") return fixtures; // Never filter knockout
  if (!FOLLOWED_COUNTRIES || FOLLOWED_COUNTRIES.length === 0) return fixtures;
  const set = new Set(FOLLOWED_COUNTRIES.map((c) => c.toLowerCase()));
  return fixtures.filter(
    (f) => set.has(f.home.toLowerCase()) || set.has(f.away.toLowerCase())
  );
}

// ─── Date Helpers ─────────────────────────────────────────────────────────────

function utcDate(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

function readableDate(dateStr) {
  return new Date(dateStr + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
