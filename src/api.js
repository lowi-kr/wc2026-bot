const BASE_URL = "https://v3.football.api-sports.io";

async function apiFetch(env, path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      "x-apisports-key": env.API_FOOTBALL_KEY,
    },
  });
  if (!res.ok) {
    throw new Error(`API-Football error: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length > 0) {
    throw new Error(`API-Football errors: ${JSON.stringify(json.errors)}`);
  }
  return json.response;
}

/**
 * Get all fixtures for the World Cup on a specific date (YYYY-MM-DD).
 */
export async function getFixturesByDate(env, date) {
  return apiFetch(
    env,
    `/fixtures?league=${env.WC_LEAGUE_ID}&season=${env.WC_SEASON}&date=${date}`
  );
}

/**
 * Get all group stage fixtures at once (called once, cached in KV).
 */
export async function getAllGroupStageFixtures(env) {
  // Group stage: June 11 – June 26 2026
  const fixtures = [];
  const dates = generateDateRange("2026-06-11", "2026-06-26");
  for (const date of dates) {
    const day = await getFixturesByDate(env, date);
    fixtures.push(...day);
  }
  return fixtures;
}

/**
 * Get currently live fixtures for the World Cup.
 */
export async function getLiveFixtures(env) {
  return apiFetch(
    env,
    `/fixtures?league=${env.WC_LEAGUE_ID}&season=${env.WC_SEASON}&live=all`
  );
}

/**
 * Get events (goals, cards, subs) for a specific fixture.
 */
export async function getFixtureEvents(env, fixtureId) {
  return apiFetch(env, `/fixtures/events?fixture=${fixtureId}`);
}

/**
 * Get final statistics/lineups summary for a finished fixture.
 */
export async function getFixtureStats(env, fixtureId) {
  return apiFetch(env, `/fixtures/statistics?fixture=${fixtureId}`);
}

// Helper: generate array of date strings between two YYYY-MM-DD dates (inclusive)
function generateDateRange(start, end) {
  const dates = [];
  const cur = new Date(start);
  const last = new Date(end);
  while (cur <= last) {
    dates.push(cur.toISOString().split("T")[0]);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}
