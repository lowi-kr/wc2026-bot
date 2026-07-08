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

export function formatSecondHalfKickoff(fixture, homeScore, awayScore) {
  return (
    `SECOND HALF UNDERWAY\n` +
    `${fixture.home} ${homeScore}-${awayScore} ${fixture.away}`
  );
}

/**
 * Announce an extra-time / shootout phase transition.
 * `phase` is one of: "et_first_half", "et_halftime", "et_second_half", "shootout".
 */
export function formatPhaseTransition(phase, fixture, homeScore, awayScore) {
  const score = `${fixture.home} ${homeScore}-${awayScore} ${fixture.away}`;
  switch (phase) {
    case "et_first_half":
      return `EXTRA TIME\n${fixture.round}\n${score}\nExtra time begins`;
    case "et_halftime":
      return `HALF TIME (Extra Time)\n${score}`;
    case "et_second_half":
      return `EXTRA TIME - SECOND HALF\n${score}`;
    case "shootout":
      return `PENALTY SHOOTOUT\n${fixture.home} vs ${fixture.away}\nScore after extra time: ${homeScore}-${awayScore}`;
    default:
      return null;
  }
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

/**
 * @param {object} fixture
 * @param {number} homeScore
 * @param {number} awayScore
 * @param {Array|null} stats — ESPN boxscore.teams
 * @param {string} statusShort — "FT" | "AET" | "PEN"
 * @param {{home:number,away:number}|null} shootout — penalty shootout score, if known
 * @param {"home"|"away"|"draw"|null} winner — ESPN's winner:true/false flag, normalized
 */
export function formatFullTime(fixture, homeScore, awayScore, stats, statusShort, shootout, winner) {
  const label =
    statusShort === "AET" ? "FULL TIME (AET)" :
    statusShort === "PEN" ? "FULL TIME (Penalties)" :
    "FULL TIME";

  // Regulation/ET score is level by definition whenever a match goes to
  // penalties (that's the entire reason it went to penalties) — so a
  // PEN result is NEVER a "Draw" overall even when homeScore===awayScore.
  // We prefer ESPN's own winner:true/false flag (passed in as `winner`,
  // one of "home"/"away"/"draw"/null) since it's authoritative and
  // correctly reflects shootout outcomes. Score comparison is only a
  // fallback for when that flag isn't present in the payload at all.
  let winnerLine;
  if (statusShort === "PEN") {
    if (shootout && (shootout.home != null) && (shootout.away != null)) {
      winnerLine = shootout.home > shootout.away
        ? `${fixture.home} win on penalties (${shootout.home}-${shootout.away})`
        : `${fixture.away} win on penalties (${shootout.away}-${shootout.home})`;
    } else if (winner === "home") {
      winnerLine = `${fixture.home} win on penalties`;
    } else if (winner === "away") {
      winnerLine = `${fixture.away} win on penalties`;
    } else {
      // No shootout score AND no winner flag — we know it went to
      // penalties but can't confirm who won. Say so rather than guessing.
      winnerLine = "Decided on penalties";
    }
  } else if (winner === "home") {
    winnerLine = `${fixture.home} win`;
  } else if (winner === "away") {
    winnerLine = `${fixture.away} win`;
  } else if (winner === "draw") {
    winnerLine = "Draw";
  } else {
    // No winner flag in the payload at all — fall back to score
    // comparison (the old behavior), which is fine for non-PEN results
    // since the score reliably reflects the outcome outside of shootouts.
    winnerLine =
      homeScore > awayScore ? `${fixture.home} win` :
      awayScore > homeScore ? `${fixture.away} win` :
      "Draw";
  }

  let msg =
    `${label}\n` +
    `${fixture.round}\n` +
    `${fixture.home} ${homeScore}-${awayScore} ${fixture.away}\n` +
    `${winnerLine}`;

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
  // scoringPlay===true is the entry condition — we only call this for real goals.
  const min   = play.clock?.displayValue || "?'";
  const team  = play.team?.displayName || "";
  const score = `${homeScore}-${awayScore}`;

  const scorer = play.participants?.find((p) => p.type?.text === "Scorer")?.athlete?.displayName;
  const assist = play.participants?.find((p) => p.type?.text === "Assist")?.athlete?.displayName;

  // Fall back to ESPN's own description text if participant data is missing
  const name = scorer || extractNameFromText(play.text) || "Goal";

  // p.ownGoal and p.penaltyKick are confirmed boolean fields on ESPN play
  // objects (verified from live WC2026 data 2026-06-29).
  const isOG      = play.ownGoal === true;
  const isPenalty = play.penaltyKick === true;

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

// ─── Chat Command Replies ─────────────────────────────────────────────────────

/**
 * Reply to the "live" command. `liveInfo` is whatever getCurrentScore()
 * in index.js resolved: { homeScore, awayScore, statusDetail, clock }.
 */
export function formatLiveReply(fixture, liveInfo) {
  const { homeScore, awayScore, statusDetail, clock } = liveInfo || {};
  const scoreLine = `${fixture.home} ${homeScore ?? "?"}-${awayScore ?? "?"} ${fixture.away}`;
  const detailLine = [clock, statusDetail].filter(Boolean).join(" - ");
  return `LIVE\n${scoreLine}${detailLine ? `\n${detailLine}` : ""}`;
}

/**
 * Reply to the "live" command for a match that's already finished.
 */
export function formatFinishedReply(fixture) {
  const label =
    fixture.status === "AET" ? "FULL TIME (AET)" :
    fixture.status === "PEN" ? "FULL TIME (Penalties)" :
    "FULL TIME";
  const h = fixture.final_home_score;
  const a = fixture.final_away_score;
  return `${label}\n${fixture.home} ${h ?? "?"}-${a ?? "?"} ${fixture.away}`;
}

/**
 * Reply to the "stats" command.
 */
export function formatStatsReply(fixture, homeScore, awayScore, stats) {
  const header = ["FT", "AET", "PEN"].includes(fixture.status) ? "FULL TIME" : "STATS";
  const statsBlock = formatStatsBlock(stats);
  let msg = `${header}\n${fixture.home} ${homeScore ?? "?"}-${awayScore ?? "?"} ${fixture.away}`;
  if (statsBlock) {
    msg += `\n\n${statsBlock}`;
  } else {
    msg += `\n\nNo stats available yet for this match.`;
  }
  return msg;
}

/**
 * Reply to the "goals" command — one line per goal, in order.
 * `goalPlays` are raw ESPN play objects already filtered to scoringPlay===true.
 */
export function formatGoalsReply(fixture, goalPlays) {
  if (!goalPlays || goalPlays.length === 0) {
    return `GOALS\n${fixture.home} vs ${fixture.away}\nNo goals yet.`;
  }

  const lines = [`GOALS\n${fixture.home} vs ${fixture.away}`];
  for (const play of goalPlays) {
    const min = play.clock?.displayValue || "?'";
    const team = play.team?.displayName || "";
    const scorer = play.participants?.find((p) => p.type?.text === "Scorer")?.athlete?.displayName;
    const name = scorer || extractNameFromText(play.text) || "Goal";
    const tag = play.ownGoal === true ? " (OG)" : play.penaltyKick === true ? " (PEN)" : "";
    lines.push(`${min} ${name}${tag}${team ? ` - ${team}` : ""}`);
  }
  return lines.join("\n");
}

/**
 * Reply when a search term matches no fixture, or nothing is live/recent.
 */
export function formatNoMatchReply(term) {
  return term
    ? `No match found for "${term}".`
    : `No match is live right now, and I couldn't find a recent one.`;
}

/**
 * Reply when more than one match is live and a command needs a team name
 * to disambiguate.
 */
export function formatAmbiguousReply(candidates, commandHint) {
  const list = candidates.map((f) => `${f.home} vs ${f.away}`).join(", ");
  return `Multiple matches live right now: ${list}\nTry "${commandHint} <team name>" to pick one.`;
}

export function formatCommandHelp() {
  return (
    `BOT COMMANDS\n` +
    `live          - score/status of the live match(es)\n` +
    `live <team>   - status of a specific match\n` +
    `stats         - stats for the active or most recent match\n` +
    `stats <team>  - stats for a specific match\n` +
    `goals         - goals so far in the active or most recent match\n` +
    `goals <team>  - goals for a specific match`
  );
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
 * non-alphanumeric characters stripped) instead of trusting one exact key
 * — this is the actual fix for corners/fouls showing up as "-": the old
 * code matched only the literal names "cornerKicks"/"fouls", which aren't
 * what ESPN's soccer feed actually uses for those two stats. Any stat with
 * no match on either side is left out of the message entirely rather than
 * rendered as a placeholder "-".
 */
export function formatStatsBlock(stats) {
  if (!stats || stats.length < 2) return null;

  const h = stats.find((t) => t.homeAway === "home") || stats[0];
  const a = stats.find((t) => t.homeAway === "away") || stats[1];

  const STAT_DEFS = [
    { label: "Possession",   aliases: ["possessionpct", "possession", "ballpossession", "possession%"] },
    { label: "Shots",        aliases: ["totalshots", "shotstotal", "shots"] },
    { label: "On Target",    aliases: ["shotsontarget", "shotsongoal", "ontargetscoringatt", "totalshotsontarget"] },
    { label: "Corners",      aliases: ["cornerkicks", "wontcorners", "corners", "cornerkicksearned"] },
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
