/**
 * formatter.js — Format all GroupMe messages
 * All times displayed in US Eastern (ET).
 * NO EMOJIS — GroupMe's SMS fallback only supports ASCII; emojis render as "????"
 *
 * ESPN play objects have a different shape than API-Football:
 *   play.type.text          — e.g. "Goal", "Yellow Card", "Substitution"
 *   play.clock.displayValue — e.g. "45'"
 *   play.participants[]     — array of { athlete: { displayName, id }, type: { text } }
 *   play.team.displayName
 *   play.text                — human-readable description ESPN generates
 */

const ET_TIMEZONE = "America/New_York";

// ─── Schedule Posts ───────────────────────────────────────────────────────────

export function formatGroupStageSchedule(fixtures, filtered, countries) {
  const lines = ["FIFA WORLD CUP 2026 - Group Stage Schedule\n"];

  if (filtered) {
    lines.push(`Tracking: ${countries.join(", ")}\n`);
  }

  if (!fixtures || fixtures.length === 0) {
    lines.push("No matching group stage fixtures found.");
    return lines.join("\n");
  }

  const byDate = groupByDate(fixtures);
  for (const date of Object.keys(byDate).sort()) {
    lines.push(readableDate(date));
    for (const f of byDate[date]) {
      lines.push(`  ${f.home} vs ${f.away}`);
      lines.push(`     ${kickoffET(f.kickoff_utc)} | ${f.round}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function formatDailySchedule(fixtures, dateLabel) {
  if (!fixtures || fixtures.length === 0) {
    return `${dateLabel}: No World Cup 2026 matches scheduled.`;
  }

  const lines = [`FIFA WORLD CUP 2026\n${dateLabel}\n`];
  for (const f of fixtures) {
    lines.push(`${f.home} vs ${f.away}`);
    lines.push(`   ${kickoffET(f.kickoff_utc)} | ${f.round}\n`);
  }
  return lines.join("\n").trimEnd();
}

// ─── Live Match Posts ─────────────────────────────────────────────────────────

export function formatKickoff(fixture) {
  return (
    `KICK OFF\n` +
    `${fixture.round}\n` +
    `${fixture.home} vs ${fixture.away}\n` +
    `${kickoffET(fixture.kickoff_utc)}`
  );
}

/**
 * Half-time message, optionally with stats if available.
 */
export function formatHalfTime(fixture, homeScore, awayScore, stats) {
  let msg =
    `HALF TIME\n` +
    `${fixture.home} ${homeScore}-${awayScore} ${fixture.away}`;

  const statsBlock = formatStatsBlock(stats);
  if (statsBlock) msg += `\n\n${statsBlock}`;

  return msg;
}

export function formatFullTime(fixture, homeScore, awayScore, stats, statusShort) {
  const label =
    statusShort === "AET" ? "FULL TIME (AET)" :
    statusShort === "PEN" ? "FULL TIME (Penalties)" :
    "FULL TIME";

  const winner =
    homeScore > awayScore ? `${fixture.home} win` :
    awayScore > homeScore ? `${fixture.away} win` :
    "Draw";

  let msg =
    `${label}\n` +
    `${fixture.round}\n` +
    `${fixture.home} ${homeScore}-${awayScore} ${fixture.away}\n` +
    `${winner}`;

  const statsBlock = formatStatsBlock(stats);
  if (statsBlock) msg += `\n\n${statsBlock}`;

  return msg;
}

/**
 * Format a single ESPN goal play into a GroupMe message.
 * Only goals are posted live (no commentary source for cards/subs yet).
 */
export function formatEvent(play, fixture, homeScore, awayScore) {
  const typeText = (play.type?.text || "").toLowerCase();
  if (!typeText.includes("goal")) return null; // Only goals, by design

  const min   = play.clock?.displayValue || "?'";
  const team  = play.team?.displayName || "";
  const score = `${homeScore}-${awayScore}`;

  const scorer = play.participants?.find((p) => p.type?.text === "Scorer")?.athlete?.displayName;
  const assist = play.participants?.find((p) => p.type?.text === "Assist")?.athlete?.displayName;

  // Fall back to ESPN's own description text if participant data is missing
  const name = scorer || extractNameFromText(play.text) || "Goal";

  const isOG      = typeText.includes("own");
  const isPenalty = typeText.includes("penalty");

  if (isOG) {
    return `${min} OWN GOAL - ${name}${team ? ` (${team})` : ""}\n${fixture.home} ${score} ${fixture.away}`;
  }
  if (isPenalty) {
    return `${min} PENALTY - ${name}${team ? ` (${team})` : ""}\n${fixture.home} ${score} ${fixture.away}`;
  }
  return (
    `${min} GOAL - ${name}${team ? ` (${team})` : ""}` +
    (assist ? ` | Assist: ${assist}` : "") +
    `\n${fixture.home} ${score} ${fixture.away}`
  );
}

/**
 * Fallback goal message when no matching play data is found at all —
 * still tells the group the score changed.
 */
export function formatGenericGoal(fixture, homeScore, awayScore) {
  return `GOAL\n${fixture.home} ${homeScore}-${awayScore} ${fixture.away}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a plain-text stats block from ESPN boxscore.teams data.
 * Returns null if stats aren't available.
 */
function formatStatsBlock(stats) {
  if (!stats || stats.length < 2) return null;

  const getStat = (teamStats, name) => {
    const list = teamStats?.statistics || [];
    return list.find((s) => s.name === name)?.displayValue ?? "-";
  };

  const h = stats.find((t) => t.homeAway === "home") || stats[0];
  const a = stats.find((t) => t.homeAway === "away") || stats[1];

  return (
    `STATS\n` +
    `Possession:  ${getStat(h, "possessionPct")} - ${getStat(a, "possessionPct")}\n` +
    `Shots:       ${getStat(h, "totalShots")} - ${getStat(a, "totalShots")}\n` +
    `On Target:   ${getStat(h, "shotsOnTarget")} - ${getStat(a, "shotsOnTarget")}\n` +
    `Corners:     ${getStat(h, "cornerKicks")} - ${getStat(a, "cornerKicks")}\n` +
    `Fouls:       ${getStat(h, "fouls")} - ${getStat(a, "fouls")}`
  );
}

/**
 * Try to pull a player name out of ESPN's auto-generated play text,
 * e.g. "Granit Xhaka  Goal - Switzerland 1, Bosnia-Herzegovina 0" -> "Granit Xhaka"
 */
function extractNameFromText(text) {
  if (!text) return null;
  const match = text.match(/^([A-Za-zÀ-ÿ' -]+?)\s+(Goal|scores)/i);
  return match ? match[1].trim() : null;
}

function kickoffET(isoDate) {
  return new Date(isoDate).toLocaleTimeString("en-US", {
    hour:         "2-digit",
    minute:       "2-digit",
    timeZone:     ET_TIMEZONE,
    timeZoneName: "short",
  });
}

function readableDate(dateStr) {
  return new Date(dateStr + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday:  "long",
    month:    "long",
    day:      "numeric",
    timeZone: "UTC",
  });
}

function groupByDate(fixtures) {
  return fixtures.reduce((acc, f) => {
    const date = f.kickoff_utc.split("T")[0];
    if (!acc[date]) acc[date] = [];
    acc[date].push(f);
    return acc;
  }, {});
}