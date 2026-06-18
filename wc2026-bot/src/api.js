/**
 * api.js — API-Football v3 wrapper
 */

const BASE = "https://v3.football.api-sports.io";

async function apiFetch(env, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "x-apisports-key": env.API_FOOTBALL_KEY },
  });
  if (!res.ok) throw new Error(`API-Football ${res.status}: ${res.statusText}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length > 0) {
    throw new Error(`API-Football errors: ${JSON.stringify(json.errors)}`);
  }
  return json.response;
}

/**
 * Fetch all fixtures for a specific date (YYYY-MM-DD).
 * Returns normalized objects ready for D1 insertion.
 */
export async function fetchFixturesByDate(env, date, stage) {
  const raw = await apiFetch(
    env,
    `/fixtures?league=${env.WC_LEAGUE_ID}&season=${env.WC_SEASON}&date=${date}`
  );
  return raw.map((f) => normalizeFixture(f, stage));
}

/**
 * Fetch all fixtures between two dates (inclusive). Used for group stage bulk load.
 */
export async function fetchFixturesInRange(env, fromDate, toDate, stage) {
  const dates = dateRange(fromDate, toDate);
  const all = [];
  for (const date of dates) {
    const fixtures = await fetchFixturesByDate(env, date, stage);
    all.push(...fixtures);
  }
  return all;
}

/**
 * Fetch currently live WC fixtures.
 */
export async function fetchLiveFixtures(env) {
  return apiFetch(
    env,
    `/fixtures?league=${env.WC_LEAGUE_ID}&season=${env.WC_SEASON}&live=all`
  );
}

/**
 * Fetch all events for a fixture (goals, cards, subs, VAR).
 */
export async function fetchEvents(env, fixtureId) {
  return apiFetch(env, `/fixtures/events?fixture=${fixtureId}`);
}

/**
 * Fetch end-of-match statistics for a fixture.
 */
export async function fetchStats(env, fixtureId) {
  return apiFetch(env, `/fixtures/statistics?fixture=${fixtureId}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeFixture(f, stage) {
  return {
    id: f.fixture.id,
    home: f.teams.home.name,
    away: f.teams.away.name,
    kickoff_utc: f.fixture.date, // ISO 8601 string
    round: f.league.round || "",
    stage: stage || deriveStage(f.league.round || ""),
  };
}

function deriveStage(round) {
  const r = round.toLowerCase();
  if (r.includes("group")) return "group";
  return "knockout";
}

function dateRange(from, to) {
  const dates = [];
  const cur = new Date(from);
  const end = new Date(to);
  while (cur <= end) {
    dates.push(cur.toISOString().split("T")[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}
