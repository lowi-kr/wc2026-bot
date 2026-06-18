import {
  getLiveFixtures,
  getFixtureEvents,
  getFixtureStats,
  getFixturesByDate,
  getAllGroupStageFixtures,
} from "./api.js";
import { postToGroupMe } from "./groupme.js";
import {
  formatSchedule,
  formatGroupStageSchedule,
  formatEvent,
  formatKickoff,
  formatHalfTime,
  formatFullTime,
} from "./formatter.js";

// ─── KV Keys ─────────────────────────────────────────────────────────────────
const KV_GROUP_STAGE_POSTED = "group_stage_schedule_posted";
const KV_SEEN_EVENTS_PREFIX = "seen_events:";   // + fixtureId
const KV_MATCH_STATE_PREFIX = "match_state:";   // + fixtureId  → "pre|live|ht|ft"
const KV_DAILY_SCHEDULE_PREFIX = "daily_sched:"; // + YYYY-MM-DD → "posted"

// ─── Cron Dispatcher ─────────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron;

    if (cron === "* * * * *") {
      // Every minute: live match polling
      ctx.waitUntil(handleLivePolling(env));
    } else if (cron === "0 8 * * *") {
      // Every day at 8AM UTC: schedule post
      ctx.waitUntil(handleDailySchedule(env));
    }
  },

  // Allow manual HTTP trigger for testing: GET /?action=schedule|live|group
  async fetch(request, env) {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    if (action === "group") {
      await postGroupStageSchedule(env, true);
      return new Response("Group stage schedule posted.");
    } else if (action === "schedule") {
      await handleDailySchedule(env, true);
      return new Response("Daily schedule posted.");
    } else if (action === "live") {
      await handleLivePolling(env);
      return new Response("Live polling run.");
    } else if (action === "reset") {
      // Reset a fixture's state for testing: ?action=reset&id=FIXTURE_ID
      const id = url.searchParams.get("id");
      if (id) {
        await env.KV.delete(KV_SEEN_EVENTS_PREFIX + id);
        await env.KV.delete(KV_MATCH_STATE_PREFIX + id);
        return new Response(`Reset fixture ${id}`);
      }
    }

    return new Response(
      "WC2026 Bot is running.\n\n" +
      "Manual triggers:\n" +
      "  ?action=group    — Post full group stage schedule\n" +
      "  ?action=schedule — Post tomorrow's schedule\n" +
      "  ?action=live     — Run live polling now\n" +
      "  ?action=reset&id=FIXTURE_ID — Reset fixture state"
    );
  },
};

// ─── Group Stage Schedule (one-time) ─────────────────────────────────────────

async function postGroupStageSchedule(env, force = false) {
  const alreadyPosted = await env.KV.get(KV_GROUP_STAGE_POSTED);
  if (alreadyPosted && !force) return;

  try {
    const fixtures = await getAllGroupStageFixtures(env);
    const msg = formatGroupStageSchedule(fixtures);
    await postToGroupMe(env, msg);
    await env.KV.put(KV_GROUP_STAGE_POSTED, "true", {
      expirationTtl: 60 * 60 * 24 * 60, // 60 days
    });
    console.log("Group stage schedule posted.");
  } catch (err) {
    console.error("Failed to post group stage schedule:", err);
  }
}

// ─── Daily Schedule ───────────────────────────────────────────────────────────

async function handleDailySchedule(env, force = false) {
  const today = getTodayUTC();

  // Post group stage schedule once (at the very first run on/after June 11)
  const groupPosted = await env.KV.get(KV_GROUP_STAGE_POSTED);
  if (!groupPosted) {
    await postGroupStageSchedule(env);
  }

  // Only post daily "tomorrow" schedule from June 27 onward
  if (today < env.DAILY_SCHEDULE_START && !force) return;

  const tomorrow = getDateOffsetUTC(1);
  const kvKey = KV_DAILY_SCHEDULE_PREFIX + tomorrow;
  const alreadyPosted = await env.KV.get(kvKey);
  if (alreadyPosted && !force) return;

  try {
    const fixtures = await getFixturesByDate(env, tomorrow);
    const label = `Tomorrow (${formatReadableDate(tomorrow)})`;
    const msg = formatSchedule(fixtures, label);
    await postToGroupMe(env, msg);
    await env.KV.put(kvKey, "true", { expirationTtl: 60 * 60 * 48 });
    console.log(`Daily schedule posted for ${tomorrow}`);
  } catch (err) {
    console.error("Failed to post daily schedule:", err);
  }
}

// ─── Live Match Polling ───────────────────────────────────────────────────────

async function handleLivePolling(env) {
  let liveFixtures;
  try {
    liveFixtures = await getLiveFixtures(env);
  } catch (err) {
    console.error("Failed to fetch live fixtures:", err);
    return;
  }

  if (!liveFixtures || liveFixtures.length === 0) {
    // No live matches — check if any matches just finished (state transition)
    await checkForJustFinished(env);
    return;
  }

  for (const fixture of liveFixtures) {
    await processLiveFixture(env, fixture);
  }
}

async function processLiveFixture(env, fixture) {
  const fixtureId = fixture.fixture.id;
  const status = fixture.fixture.status.short; // NS, 1H, HT, 2H, ET, P, FT, AET, PEN
  const home = fixture.teams.home.name;
  const away = fixture.teams.away.name;

  const stateKey = KV_MATCH_STATE_PREFIX + fixtureId;
  const prevState = (await env.KV.get(stateKey)) || "pre";

  // ── Kickoff
  if (prevState === "pre" && ["1H", "2H", "ET"].includes(status)) {
    await postToGroupMe(env, formatKickoff(fixture));
    await env.KV.put(stateKey, "live", { expirationTtl: 60 * 60 * 6 });
  }

  // ── Half Time
  if (status === "HT" && prevState !== "ht") {
    await postToGroupMe(env, formatHalfTime(fixture));
    await env.KV.put(stateKey, "ht", { expirationTtl: 60 * 60 * 6 });
  }

  // ── Full Time / AET / Penalties
  if (["FT", "AET", "PEN"].includes(status) && !["ft", "aet", "pen"].includes(prevState)) {
    await handleMatchEnd(env, fixture, status.toLowerCase());
    return;
  }

  // ── Live events (goals, cards, subs)
  if (["1H", "2H", "ET", "P"].includes(status)) {
    await pollEvents(env, fixture);
  }
}

async function pollEvents(env, fixture) {
  const fixtureId = fixture.fixture.id;
  const home = fixture.teams.home.name;
  const away = fixture.teams.away.name;

  let events;
  try {
    events = await getFixtureEvents(env, fixtureId);
  } catch (err) {
    console.error(`Failed to fetch events for fixture ${fixtureId}:`, err);
    return;
  }

  if (!events || events.length === 0) return;

  // Load seen event IDs from KV
  const seenKey = KV_SEEN_EVENTS_PREFIX + fixtureId;
  const seenRaw = await env.KV.get(seenKey);
  const seen = new Set(seenRaw ? JSON.parse(seenRaw) : []);

  const newMessages = [];

  for (const event of events) {
    // Unique event key: minute + type + player
    const eventId = `${event.time.elapsed}${event.time.extra || ""}_${event.type}_${event.player?.id || "x"}`;

    if (seen.has(eventId)) continue;
    seen.add(eventId);

    const hs = fixture.goals.home ?? 0;
    const as = fixture.goals.away ?? 0;
    const msg = formatEvent(event, home, away, hs, as);
    if (msg) newMessages.push(msg);
  }

  // Post new events
  for (const msg of newMessages) {
    await postToGroupMe(env, msg);
  }

  // Persist updated seen set
  await env.KV.put(seenKey, JSON.stringify([...seen]), {
    expirationTtl: 60 * 60 * 12,
  });
}

async function handleMatchEnd(env, fixture, statusKey) {
  const fixtureId = fixture.fixture.id;
  const stateKey = KV_MATCH_STATE_PREFIX + fixtureId;

  let stats = null;
  try {
    stats = await getFixtureStats(env, fixtureId);
  } catch (err) {
    console.error(`Could not fetch stats for fixture ${fixtureId}:`, err);
  }

  const msg = formatFullTime(fixture, stats);
  await postToGroupMe(env, msg);
  await env.KV.put(stateKey, statusKey, { expirationTtl: 60 * 60 * 24 });
}

/**
 * Check recently-finished matches that may have ended between polling cycles.
 * Looks at fixtures from today that are in KV as "live" but not yet "ft".
 */
async function checkForJustFinished(env) {
  // This is a safety net — in practice the live polling above catches FT status.
  // We list KV match_state keys and check any still "live" or "ht".
  // Cloudflare KV list is eventually consistent, so this is best-effort.
  try {
    const list = await env.KV.list({ prefix: KV_MATCH_STATE_PREFIX });
    for (const key of list.keys) {
      const state = await env.KV.get(key.name);
      if (state === "live" || state === "ht") {
        const fixtureId = key.name.replace(KV_MATCH_STATE_PREFIX, "");
        // Try fetching this specific fixture
        const fixtures = await getLiveFixtures(env); // already checked — empty
        // If it's not live anymore, try fetching by ID via today's date
        const today = getTodayUTC();
        const todayFixtures = await getFixturesByDate(env, today);
        const match = todayFixtures.find((f) => String(f.fixture.id) === fixtureId);
        if (match) {
          const s = match.fixture.status.short;
          if (["FT", "AET", "PEN"].includes(s)) {
            await handleMatchEnd(env, match, s.toLowerCase());
          }
        }
      }
    }
  } catch (err) {
    console.error("checkForJustFinished error:", err);
  }
}

// ─── Date Helpers ─────────────────────────────────────────────────────────────

function getTodayUTC() {
  return new Date().toISOString().split("T")[0];
}

function getDateOffsetUTC(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function formatReadableDate(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
