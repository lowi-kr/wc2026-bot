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
 * Follow-up message used when full-time stats weren't ready yet at the
 * moment FULL TIME was posted, and arrived later on a retry instead.
 * Kept as a separate function so the FULL TIME result itself is never
 * delayed waiting on stats.
 */
export function formatFinalStatsFollowUp(fixture, homeScore, awayScore, stats) {
  const statsBlock = formatStatsBlock(stats);
  if (!statsBlock) return null;
  return (
    `FINAL STATS\n` +
    `${fixture.home} ${homeScore}-${awayScore} ${fixture.away}\n\n` +
    `${statsBlock}`
  );
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
 * Returns null if no stats could be matched at all.
 *
 * ESPN's soccer "statistics" entries don't reliably use the same `name`
 * key across feeds/seasons, but every entry also carries a human-readable
 * `label` (and often an `abbreviation`). We match against a list of known
 * aliases per stat against name/label/abbreviation (lowercased, with
 * non-alphanumeric characters stripped) instead of trusting one exact key.
 * Any stat with no match on either side is left out of the message
 * entirely rather than rendered as a placeholder "-" — so the block always
 * reflects what ESPN actually sent, and silently grows if ESPN adds stats
 * we haven't aliased yet (we just won't show them) rather than silently
 * showing wrong/empty values for stats we expected but couldn't find.
 */
function formatStatsBlock(stats) {
  if (!stats || stats.length < 2) return null;

  const h = stats.find((t) => t.homeAway === "home") || stats[0];
  const a = stats.find((t) => t.homeAway === "away") || stats[1];

  const STAT_DEFS = [
    { label: "Possession",   aliases: ["possessionpct", "possession", "ballpossession", "possession%"] },
    { label: "Shots",        aliases: ["totalshots", "shotstotal", "shots"] },
    { label: "On Target",    aliases: ["shotsontarget", "shotsongoal", "ontargetscoringatt", "totalshotsontarget"] },
    { label: "Corners",      aliases: ["cornerkicks", "wontcorners", "wonCorners".toLowerCase(), "corners", "cornerkicksearned"] },
    { label: "Fouls",        aliases: ["fouls", "foulscommitted", "foulscommited"] },
    { label: "Yellow Cards", aliases: ["yellowcards", "totalyellowcards"] },
    { label: "Red Cards",    aliases: ["redcards", "totalredcards"] },
    { label: "Offsides",     aliases: ["offsides", "totaloffsides"] },
  ];

  const rows = [];
  for (const def of STAT_DEFS) {
    const hVal = findStat(h, def.aliases);
    const aVal = findStat(a, def.aliases);
    if (hVal == null && aVal == null) continue; // not found on either side — skip the row
    rows.push(`${padLabel(def.label)} ${hVal ?? "-"} - ${aVal ?? "-"}`);
  }

  if (rows.length === 0) return null;
  return `STATS\n` + rows.join("\n");
}

/**
 * Find a stat's displayValue by matching its `name`, `label`, or
 * `abbreviation` field (normalized: lowercased, non-alphanumeric stripped)
 * against a list of known aliases.
 */
function findStat(teamStats, aliases) {
  const list = teamStats?.statistics || [];
  for (const s of list) {
    const candidates = [s.name, s.label, s.abbreviation]
      .filter(Boolean)
      .map((v) => v.toLowerCase().replace(/[^a-z0-9%]/g, ""));
    if (candidates.some((c) => aliases.includes(c))) {
      return s.displayValue ?? null;
    }
  }
  return null;
}

function padLabel(label) {
  const width = 13;
  return (label + ":").padEnd(width, " ");
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
