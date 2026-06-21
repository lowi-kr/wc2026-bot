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
 * Fetch all WC 2026 fixtures in a date range. Used once for group stage bulk load.
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
 * @returns {Array} normalized fixture objects
 */
export async function fetchFixturesByDate(_env, date, stage) {
  const d    = toESPNDate(date);
  const url  = `${SITE_API}/scoreboard?dates=${d}&limit=50`;
  const data = await espnFetch(url);
  return (data.events || []).map((e) => normalizeFixture(e, stage));
}

/**
 * Fetch all currently live WC fixtures from the scoreboard.
 * ESPN's scoreboard returns today's games including live ones.
 * We filter to only "in progress" state.
 * @returns {Array} raw ESPN event objects (not normalized) for live processing
 */
export async function fetchLiveFixtures(_env) {
  const url  = `${SITE_API}/scoreboard`;
  const data = await espnFetch(url);
  return (data.events || []).filter(
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
  const comp       = event.competitions?.[0];
  const home       = comp?.competitors?.find((c) => c.homeAway === "home");
  const away       = comp?.competitors?.find((c) => c.homeAway === "away");
  const roundName  = event.season?.slug || comp?.notes?.[0]?.headline || "";
  const statusState = comp?.status?.type?.state || "pre";

  return {
    id:          parseInt(event.id, 10),
    home:        home?.team?.displayName || "?",
    away:        away?.team?.displayName || "?",
    kickoff_utc: event.date,             // ISO 8601 e.g. "2026-06-14T18:00Z"
    round:       comp?.notes?.[0]?.headline || roundName,
    stage:       stage || deriveStage(roundName),
    // Pass through ESPN status so index.js can read it
    espn_status: statusState,
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

const MAX_RETRIES   = 2;       // total attempts = MAX_RETRIES + 1
const BASE_DELAY_MS = 400;     // first retry waits ~400ms, then ~800ms
const MAX_DELAY_MS  = 3000;    // cap any single wait — cron has a tight budget

/**
 * Fetch from ESPN and return parsed JSON.
 * ESPN doesn't require auth headers — plain fetch works from Workers.
 *
 * Retries on transient failures only:
 *   - network errors (fetch throwing, e.g. DNS hiccup, connection reset)
 *   - 5xx server errors
 *   - 429 rate limiting (honors Retry-After header if ESPN sends one)
 * Does NOT retry 4xx errors other than 429 — a 404 or bad request will
 * never succeed on retry, so we fail fast instead of burning the cron's
 * limited time budget (the minute-poll cron has well under 60s before
 * the next invocation fires).
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
      // Network-level failure (fetch threw) — always retryable
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
    const delay = retryAfterMs && !isNaN(retryAfterMs)
      ? Math.min(retryAfterMs, MAX_DELAY_MS)
      : backoffDelay(attempt);

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
