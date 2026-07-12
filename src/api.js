/**
 * api.js — ESPN unofficial API wrapper for FIFA World Cup 2026
 *
 * No API key required. No proxy needed. Works natively from Cloudflare Workers.
 *
 * Endpoints used:
 *   Scoreboard (schedule + live scores):
 *     https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard
 *
 *   Play-by-play (goals, cards, subs):
 *     https://sports.core.api.espn.com/v2/sports/soccer/leagues/fifa.world/events/{id}/competitions/{id}/plays?limit=300
 *
 *   Match summary (full-time stats):
 *     https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event={id}
 *
 * IMPORTANT — ESPN date bucketing:
 *   ESPN's `dates=YYYYMMDD` scoreboard parameter groups matches by ESPN's own
 *   match-day convention (roughly US-local time), NOT UTC midnight. A match
 *   stored in our own D1 under UTC date "2026-07-12" (kickoff 01:00 UTC) can
 *   be completely absent from ESPN's `dates=20260712` response, because ESPN
 *   still considers it part of July 11's schedule. Any code that needs "the
 *   fixture(s) for UTC date X" from ESPN should use fetchFixturesPadded()
 *   below, which pads the request by a day on each side, rather than
 *   fetchFixturesByDate() with a single exact date.
 */

const SITE_API   = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";
const CORE_API   = "https://sports.core.api.espn.com/v2/sports/soccer/leagues/fifa.world";

// ESPN status short codes we care about
// "pre"  → not started (maps to our "NS")
// "in"   → in progress (maps to "1H", "HT", "2H", "ET", "P")
// "post" → finished    (maps to "FT", "AET", "PEN")
export const ESPN_STATUS = {
  PRE:  "pre",
  IN:   "in",
  POST: "post",
};

// ─── Schedule & Scoreboard ────────────────────────────────────────────────────

/**
 * Fetch all WC 2026 fixtures in a date range. Used once for group stage bulk load,
 * and internally by fetchFixturesPadded() to dodge ESPN's date-bucketing quirk.
 * ESPN allows a date range in one call: ?dates=YYYYMMDD-YYYYMMDD
 * @returns {Array} normalized fixture objects ready for D1 upsert
 */
export async function fetchFixturesInRange(_env, fromDate, toDate, stage) {
  const from = toESPNDate(fromDate);
  const to   = toESPNDate(toDate);
  const url  = `${SITE_API}/scoreboard?dates=${from}-${to}&limit=200`;
  const data = await espnFetch(url);
  return (data.events || []).map((e) => normalizeFixture(e, stage));
}

/**
 * Fetch fixtures for a single date (YYYY-MM-DD).
 * CAUTION: subject to ESPN's date-bucketing quirk (see file header) — a
 * fixture near UTC midnight may not appear in the response for the "correct"
 * UTC date. Prefer fetchFixturesPadded() unless you specifically want ESPN's
 * own idea of "that day's" schedule (e.g. display purposes only).
 * @returns {Array} normalized fixture objects
 */
export async function fetchFixturesByDate(_env, date, stage) {
  const d    = toESPNDate(date);
  const url  = `${SITE_API}/scoreboard?dates=${d}&limit=50`;
  const data = await espnFetch(url);
  return (data.events || []).map((e) => normalizeFixture(e, stage));
}

/**
 * Fetch fixtures "around" a given UTC date (date-1 to date+1) to dodge ESPN's
 * date-bucketing convention. Use this instead of fetchFixturesByDate()
 * whenever the goal is "find fixture(s) that belong to UTC date X" — e.g.
 * refreshing D1, reconciling a stuck fixture, or looking up tomorrow's slate.
 * Safe to upsert the full padded result into D1; D1's own kickoff_utc-based
 * date filtering (getFixturesByDate) will still scope display correctly.
 * @returns {Array} normalized fixture objects
 */
export async function fetchFixturesPadded(env, dateStr, stage, padDays = 1) {
  const from = addDaysUTC(dateStr, -padDays);
  const to   = addDaysUTC(dateStr, padDays);
  return fetchFixturesInRange(env, from, to, stage);
}

/**
 * Fetch ALL current scoreboard events (today's slate per ESPN's own bucketing),
 * regardless of status — pre, in, or post. Unlike fetchLiveFixtures(), this
 * does NOT filter to in-progress matches, so a fixture that just flipped to
 * "post" is still visible here. Use this for live polling, where you need to
 * detect the pre→in and in→post transitions, not just "currently in".
 * @returns {Array} raw ESPN event objects (not normalized)
 */
export async function fetchScoreboardEvents(_env) {
  const url  = `${SITE_API}/scoreboard`;
  const data = await espnFetch(url);
  return data.events || [];
}

/**
 * Fetch only currently in-progress WC fixtures from the scoreboard.
 * Filtered to state === "in" — a fixture that has finished will NOT appear
 * here. Fine for callers that only care about "is it live right now" (e.g.
 * chat commands checking current score of an active match), but NOT suitable
 * for live-polling terminal-state detection — use fetchScoreboardEvents() for that.
 * @returns {Array} raw ESPN event objects (not normalized) for live processing
 */
export async function fetchLiveFixtures(_env) {
  const events = await fetchScoreboardEvents(_env);
  return events.filter(
    (e) => e.competitions?.[0]?.status?.type?.state === ESPN_STATUS.IN
  );
}

// ─── Play-by-Play Events ──────────────────────────────────────────────────────

/**
 * Fetch all play-by-play events for a fixture (goals, cards, subs).
 * @param {string|number} fixtureId — ESPN event ID
 * @returns {Array} raw ESPN play objects
 */
export async function fetchEvents(_env, fixtureId) {
  const url = `${CORE_API}/events/${fixtureId}/competitions/${fixtureId}/plays?limit=300`;
  const data = await espnFetch(url);
  return data.items || [];
}

// ─── Full-Time Stats ──────────────────────────────────────────────────────────

/**
 * Fetch full-time match statistics for a finished fixture.
 * @returns {Object|null} { home: [...stats], away: [...stats] } or null
 */
export async function fetchStats(_env, fixtureId) {
  const url  = `${SITE_API}/summary?event=${fixtureId}`;
  const data = await espnFetch(url);
  // ESPN summary returns boxscore.teams array: [homeTeamStats, awayTeamStats]
  return data.boxscore?.teams || null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalize an ESPN scoreboard event into our D1 fixture shape.
 */
function normalizeFixture(event, stage) {
  const comp        = event.competitions?.[0];
  const home        = comp?.competitors?.find((c) => c.homeAway === "home");
  const away        = comp?.competitors?.find((c) => c.homeAway === "away");
  const roundName   = event.season?.slug || comp?.notes?.[0]?.headline || "";
  const statusType  = comp?.status?.type;
  const statusState = statusType?.state || "pre";

  return {
    id:          parseInt(event.id, 10),
    home:        home?.team?.displayName || "?",
    away:        away?.team?.displayName || "?",
    kickoff_utc: event.date,             // ISO 8601 e.g. "2026-06-14T18:00Z"
    round:       comp?.notes?.[0]?.headline || roundName,
    stage:       stage || deriveStage(roundName),
    // Pass through ESPN status so index.js can read it
    espn_status:      statusState,
    // Raw status name (e.g. "STATUS_FULL_TIME", "STATUS_PENALTY") — needed by
    // callers (like checkIfFinished's fallback finalization) that only have
    // normalized fixtures and still need to distinguish FT / AET / PEN.
    espn_status_name: statusType?.name || "",
    home_score:  parseInt(home?.score || "0", 10),
    away_score:  parseInt(away?.score || "0", 10),
  };
}

/**
 * Derive stage ("group" | "knockout") from a round label.
 */
function deriveStage(round) {
  if (!round) return "knockout";
  const r = round.toLowerCase();
  if (r.includes("group")) return "group";
  return "knockout";
}

/**
 * Convert YYYY-MM-DD → YYYYMMDD for ESPN date params.
 */
function toESPNDate(dateStr) {
  return dateStr.replace(/-/g, "");
}

/**
 * Add N days (positive or negative) to a YYYY-MM-DD UTC date string.
 */
function addDaysUTC(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0];
}

const MAX_RETRIES   = 2;
const BASE_DELAY_MS = 400;
const MAX_DELAY_MS  = 3000;

/**
 * Fetch from ESPN and return parsed JSON.
 * ESPN doesn't require auth headers — plain fetch works from Workers.
 * Retries on network errors and 429/5xx with capped exponential backoff.
 */
async function espnFetch(url) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          // Mimic a browser to avoid any potential blocks
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (compatible; WC2026Bot/1.0)",
        },
      });
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw new Error(`ESPN fetch network error after ${attempt + 1} attempts: ${url} (${err.message})`);
    }

    if (res.ok) return res.json();

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_RETRIES) {
      throw new Error(`ESPN API ${res.status}: ${url}`);
    }

    const retryAfterHeader = res.headers.get("Retry-After");
    const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : null;
    const delay = retryAfterMs && !isNaN(retryAfterMs) ? Math.min(retryAfterMs, MAX_DELAY_MS) : backoffDelay(attempt);
    lastErr = new Error(`ESPN API ${res.status}: ${url}`);
    await sleep(delay);
  }
  throw lastErr;
}

function backoffDelay(attempt) {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
    }
