/**
 * commands.js — GroupMe chat command routing
 */

import { fetchLiveFixtures, fetchFixturesPadded, fetchEvents, fetchStats } from "./api.js";
import { postToGroupMe } from "./groupme.js";
import {
  formatCommandHelp,
  formatAmbiguousReply,
  formatNoMatchReply,
  formatFinishedReply,
  formatLiveReply,
  formatStatsReply,
  formatGoalsReply,
  formatCardsReply,
  formatSubsReply,
  formatNextReply,
  formatTodayReply,
  formatStatusReply,
  formatAdminFixtureList,
  formatRefreshReply,
  formatReconcileReply,
  formatFollowReply,
  formatMuteReply,
} from "./formatter.js";
import {
  findFixtureByTeam,
  getCurrentlyLiveFixtures,
  getMostRecentFinishedFixture,
  getUpcomingFixtures,
  getFixturesByDate,
  getFixtureStatusCounts,
  getStuckFixtures,
  getFollowedOverrides,
  addFollowedOverride,
  removeFollowedOverride,
  upsertFixtures,
  updateFixtureStatus,
  setFinalScore,
  logEvent,
  getState,
  setState,
} from "./db.js";

const MUTE_KV_KEY = "muted_until";

export async function routeCommand(env, body, jobFns) {
  const text = (body.text || "").trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  const isAdmin = Boolean(env.ADMIN_GROUPME_USER_ID) && body.user_id === env.ADMIN_GROUPME_USER_ID;

  let match;
  if ((match = lower.match(/^live\b\s*(.*)$/))) {
    await handleLiveCommand(env, match[1].trim());
    return true;
  }
  if ((match = lower.match(/^stats\b\s*(.*)$/))) {
    await handleStatsCommand(env, match[1].trim());
    return true;
  }
  if ((match = lower.match(/^goals\b\s*(.*)$/))) {
    await handleGoalsCommand(env, match[1].trim());
    return true;
  }
  if ((match = lower.match(/^cards\b\s*(.*)$/))) {
    await handleCardsCommand(env, match[1].trim());
    return true;
  }
  if ((match = lower.match(/^subs\b\s*(.*)$/))) {
    await handleSubsCommand(env, match[1].trim());
    return true;
  }
  if ((match = lower.match(/^next\b\s*(.*)$/))) {
    await handleNextCommand(env, match[1].trim());
    return true;
  }
  if (lower === "today") {
    await handleTodayCommand(env);
    return true;
  }
  if (lower === "!help" || lower === "commands") {
    await postToGroupMe(env, formatCommandHelp(isAdmin), { bypassMute: true });
    return true;
  }
  if (lower.startsWith("!admin")) {
    if (!isAdmin) {
      await postToGroupMe(env, "Not authorized for admin commands.", { bypassMute: true });
      return true;
    }
    await handleAdminCommand(env, lower.replace(/^!admin\b\s*/, "").trim(), jobFns);
    return true;
  }
  return false;
}

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
  if (ambiguous) return postToGroupMe(env, formatAmbiguousReply(candidates, "live"), { bypassMute: true });
  if (!fixture) return postToGroupMe(env, formatNoMatchReply(term), { bypassMute: true });
  if (["FT", "AET", "PEN"].includes(fixture.status)) {
    return postToGroupMe(env, formatFinishedReply(fixture), { bypassMute: true });
  }
  const liveInfo = await getCurrentScore(env, fixture);
  await postToGroupMe(env, formatLiveReply(fixture, liveInfo), { bypassMute: true });
}

async function handleStatsCommand(env, term) {
  const { fixture, ambiguous, candidates } = await resolveTargetFixture(env, term);
  if (ambiguous) return postToGroupMe(env, formatAmbiguousReply(candidates, "stats"), { bypassMute: true });
  if (!fixture) return postToGroupMe(env, formatNoMatchReply(term), { bypassMute: true });
  const score = await getCurrentScore(env, fixture);
  let stats = null;
  try {
    stats = await fetchStats(env, fixture.id);
  } catch (err) {
    await logEvent(env.DB, "warn", `[command] stats fetch failed for fixture ${fixture.id}: ${err.message}`);
  }
  await postToGroupMe(env, formatStatsReply(fixture, score.homeScore, score.awayScore, stats), { bypassMute: true });
}

async function handleGoalsCommand(env, term) {
  const { fixture, ambiguous, candidates } = await resolveTargetFixture(env, term);
  if (ambiguous) return postToGroupMe(env, formatAmbiguousReply(candidates, "goals"), { bypassMute: true });
  if (!fixture) return postToGroupMe(env, formatNoMatchReply(term), { bypassMute: true });
  let plays;
  try {
    plays = await fetchEvents(env, fixture.id);
  } catch (err) {
    await logEvent(env.DB, "warn", `[command] goals fetch failed for fixture ${fixture.id}: ${err.message}`);
    return postToGroupMe(env, `Couldn't fetch goal data for ${fixture.home} vs ${fixture.away} right now — try again shortly.`, { bypassMute: true });
  }
  const goalPlays = (plays || []).filter((p) => p.scoringPlay === true);
  await postToGroupMe(env, formatGoalsReply(fixture, goalPlays), { bypassMute: true });
}

async function handleCardsCommand(env, term) {
  const { fixture, ambiguous, candidates } = await resolveTargetFixture(env, term);
  if (ambiguous) return postToGroupMe(env, formatAmbiguousReply(candidates, "cards"), { bypassMute: true });
  if (!fixture) return postToGroupMe(env, formatNoMatchReply(term), { bypassMute: true });
  let plays;
  try {
    plays = await fetchEvents(env, fixture.id);
  } catch (err) {
    await logEvent(env.DB, "warn", `[command] cards fetch failed for fixture ${fixture.id}: ${err.message}`);
    return postToGroupMe(env, `Couldn't fetch card data for ${fixture.home} vs ${fixture.away} right now — try again shortly.`, { bypassMute: true });
  }
  const cardPlays = (plays || []).filter((p) => p.yellowCard === true || p.redCard === true);
  await postToGroupMe(env, formatCardsReply(fixture, cardPlays), { bypassMute: true });
}

async function handleSubsCommand(env, term) {
  const { fixture, ambiguous, candidates } = await resolveTargetFixture(env, term);
  if (ambiguous) return postToGroupMe(env, formatAmbiguousReply(candidates, "subs"), { bypassMute: true });
  if (!fixture) return postToGroupMe(env, formatNoMatchReply(term), { bypassMute: true });
  let plays;
  try {
    plays = await fetchEvents(env, fixture.id);
  } catch (err) {
    await logEvent(env.DB, "warn", `[command] subs fetch failed for fixture ${fixture.id}: ${err.message}`);
    return postToGroupMe(env, `Couldn't fetch substitution data for ${fixture.home} vs ${fixture.away} right now — try again shortly.`, { bypassMute: true });
  }
  const subPlays = (plays || []).filter((p) => p.substitution === true);
  await postToGroupMe(env, formatSubsReply(fixture, subPlays), { bypassMute: true });
}

async function handleNextCommand(env, term) {
  const fixtures = await getUpcomingFixtures(env.DB, term || null, term ? 3 : 5);
  await postToGroupMe(env, formatNextReply(fixtures, term), { bypassMute: true });
}

async function handleTodayCommand(env) {
  const today = new Date().toISOString().split("T")[0];
  const fixtures = await getFixturesByDate(env.DB, today);
  await postToGroupMe(env, formatTodayReply(fixtures), { bypassMute: true });
}

async function handleAdminCommand(env, rest, jobFns) {
  let match;
  if ((match = rest.match(/^fixtures\b\s*(.*)$/))) {
    return handleAdminFixtures(env, match[1].trim());
  }
  if (rest === "refresh") {
    return handleAdminRefresh(env);
  }
  if (rest === "reconcile") {
    return handleAdminReconcile(env);
  }
  if (rest === "status") {
    return handleAdminStatus(env);
  }
  if ((match = rest.match(/^follow\s+(.+)$/))) {
    const list = await addFollowedOverride(env.DB, match[1].trim());
    await logEvent(env.DB, "info", `[admin] followed override added: "${match[1].trim()}"`);
    return postToGroupMe(env, formatFollowReply("add", match[1].trim(), list), { bypassMute: true });
  }
  if ((match = rest.match(/^unfollow\s+(.+)$/))) {
    const list = await removeFollowedOverride(env.DB, match[1].trim());
    await logEvent(env.DB, "info", `[admin] followed override removed: "${match[1].trim()}"`);
    return postToGroupMe(env, formatFollowReply("remove", match[1].trim(), list), { bypassMute: true });
  }
  if ((match = rest.match(/^mute\s+(\d+)$/))) {
    const minutes = parseInt(match[1], 10);
    const until = Date.now() + minutes * 60 * 1000;
    await env.KV.put(MUTE_KV_KEY, String(until), { expirationTtl: minutes * 60 + 60 });
    await logEvent(env.DB, "info", `[admin] muted for ${minutes} minute(s)`);
    return postToGroupMe(env, formatMuteReply(minutes), { bypassMute: true });
  }
  if (rest === "unmute") {
    await env.KV.delete(MUTE_KV_KEY);
    await logEvent(env.DB, "info", `[admin] unmuted`);
    return postToGroupMe(env, formatMuteReply(null), { bypassMute: true });
  }
  if ((match = rest.match(/^run\s+(\w+)$/))) {
    return handleAdminRun(env, match[1], jobFns);
  }
  return postToGroupMe(env, `Unknown admin command. Try "!help" for the full list.`, { bypassMute: true });
}

async function handleAdminFixtures(env, dateArg) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : new Date().toISOString().split("T")[0];
  const fixtures = await getFixturesByDate(env.DB, date);
  await postToGroupMe(env, formatAdminFixtureList(fixtures, date), { bypassMute: true });
}

/**
 * Re-fetch today's fixtures from ESPN. Uses fetchFixturesPadded (±1 day)
 * rather than an exact-date fetch — see api.js header comment on ESPN's
 * date-bucketing behavior. Without this, a fixture near a UTC day boundary
 * would come back with 0 results from an exact-date ESPN query even though
 * it's clearly "today" in our own storage.
 */
async function handleAdminRefresh(env) {
  const today = new Date().toISOString().split("T")[0];
  try {
    const raw = await fetchFixturesPadded(env, today, undefined);
    await upsertFixtures(env.DB, raw);
    await logEvent(env.DB, "info", `[admin] refresh: re-fetched ${raw.length} fixture(s) around ${today} from ESPN`);
    await postToGroupMe(env, formatRefreshReply(raw.length, today), { bypassMute: true });
  } catch (err) {
    await logEvent(env.DB, "error", `[admin] refresh failed: ${err.message}`);
    await postToGroupMe(env, `Refresh failed: ${err.message}`, { bypassMute: true });
  }
}

/**
 * Re-check stuck LIVE/HT/NS fixtures against ESPN. Uses fetchFixturesPadded
 * around each fixture's own kickoff date instead of an exact-date fetch —
 * an exact match on the fixture's UTC kickoff date can still miss it on
 * ESPN's side for the same date-bucketing reason (see api.js).
 */
async function handleAdminReconcile(env) {
  const stuck = await getStuckFixtures(env.DB);
  if (stuck.length === 0) {
    return postToGroupMe(env, formatReconcileReply([]), { bypassMute: true });
  }
  const results = [];
  for (const fixture of stuck) {
    const date = fixture.kickoff_utc.split("T")[0];
    try {
      const espnFixtures = await fetchFixturesPadded(env, date, fixture.stage);
      const match = espnFixtures.find((f) => f.id === fixture.id);
      if (!match) {
        results.push({ ...fixture, before: fixture.status, after: fixture.status, note: "not found on ESPN around that date" });
        continue;
      }
      if (match.espn_status === "post") {
        await updateFixtureStatus(env.DB, fixture.id, "FT");
        await setFinalScore(env.DB, fixture.id, match.home_score, match.away_score);
        results.push({
          ...fixture,
          before: fixture.status,
          after: `FT ${match.home_score}-${match.away_score}`,
        });
      } else {
        results.push({ ...fixture, before: fixture.status, after: fixture.status, note: `still "${match.espn_status}" per ESPN` });
      }
    } catch (err) {
      await logEvent(env.DB, "warn", `[admin] reconcile fetch failed for fixture ${fixture.id}: ${err.message}`);
      results.push({ ...fixture, before: fixture.status, after: fixture.status, note: "fetch failed" });
    }
  }
  await logEvent(env.DB, "info", `[admin] reconcile: checked ${stuck.length} stuck fixture(s)`);
  await postToGroupMe(env, formatReconcileReply(results), { bypassMute: true });
}

async function handleAdminStatus(env) {
  const gamesToday = await env.KV.get("games_today");
  const gameImminent = await env.KV.get("game_imminent");
  const mutedUntilRaw = await env.KV.get(MUTE_KV_KEY);
  const muted = mutedUntilRaw && Date.now() < parseInt(mutedUntilRaw, 10);
  const statusCounts = await getFixtureStatusCounts(env.DB);
  await postToGroupMe(
    env,
    formatStatusReply({ gamesToday, gameImminent, statusCounts, muted }),
    { bypassMute: true }
  );
}

async function handleAdminRun(env, job, jobFns) {
  const jobs = {
    daily:    () => jobFns.runDailyJob(env, true),
    hourly:   () => jobFns.runHourlyCheck(env),
    midnight: () => jobFns.runMidnightCheck(env),
    live:     () => jobFns.runLivePolling(env),
  };
  if (!jobs[job]) {
    return postToGroupMe(env, `Unknown job "${job}". Try: daily, hourly, midnight, live.`, { bypassMute: true });
  }
  await logEvent(env.DB, "info", `[admin] manually running job "${job}"`);
  await jobs[job]();
  await postToGroupMe(env, `Ran "${job}".`, { bypassMute: true });
}

export async function getEffectiveFollowedTeams(env, staticList) {
  const overrides = await getFollowedOverrides(env.DB);
  const set = new Set([...(staticList || []), ...overrides]);
  return Array.from(set);
}
