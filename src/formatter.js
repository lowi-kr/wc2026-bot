/**
 * formatter.js — Format all GroupMe messages
 * All times displayed in US Eastern (ET).
 * NO EMOJIS — GroupMe's SMS fallback only supports ASCII; emojis render as "????"
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
  return `SECOND HALF UNDERWAY\n${fixture.home} ${homeScore}-${awayScore} ${fixture.away}`;
}

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

export function formatHalfTime(fixture, homeScore, awayScore, stats) {
  let msg =
    `HALF TIME\n` +
    `${fixture.home} ${homeScore}-${awayScore} ${fixture.away}`;

  const statsBlock = formatStatsBlock(stats);
  if (statsBlock) msg += `\n\n${statsBlock}`;

  return msg;
}

export function formatFullTime(fixture, homeScore, awayScore, stats, statusShort, shootout, winner) {
  const label =
    statusShort === "AET" ? "FULL TIME (AET)" :
    statusShort === "PEN" ? "FULL TIME (Penalties)" :
    "FULL TIME";

  let winnerLine;
  if (statusShort === "PEN") {
    if (shootout && shootout.home != null && shootout.away != null) {
      winnerLine = shootout.home > shootout.away
        ? `${fixture.home} win on penalties (${shootout.home}-${shootout.away})`
        : `${fixture.away} win on penalties (${shootout.away}-${shootout.home})`;
    } else if (winner === "home") {
      winnerLine = `${fixture.home} win on penalties`;
    } else if (winner === "away") {
      winnerLine = `${fixture.away} win on penalties`;
    } else {
      winnerLine = "Decided on penalties";
    }
  } else if (winner === "home") {
    winnerLine = `${fixture.home} win`;
  } else if (winner === "away") {
    winnerLine = `${fixture.away} win`;
  } else if (winner === "draw") {
    winnerLine = "Draw";
  } else {
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

export function formatFinalStatsFollowUp(fixture, homeScore, awayScore, stats) {
  const statsBlock = formatStatsBlock(stats);
  if (!statsBlock) return null;
  return `FINAL STATS\n${fixture.home} ${homeScore}-${awayScore} ${fixture.away}\n\n${statsBlock}`;
}

export function formatEvent(play, fixture, homeScore, awayScore) {
  const min   = play.clock?.displayValue || "?'";
  const team  = play.team?.displayName || "";
  const score = `${homeScore}-${awayScore}`;

  const scorer = play.participants?.find((p) => p.type?.text === "Scorer")?.athlete?.displayName;
  const assist = play.participants?.find((p) => p.type?.text === "Assist")?.athlete?.displayName;

  const name = scorer || extractNameFromText(play.text) || "Goal";

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

export function formatGenericGoal(fixture, homeScore, awayScore) {
  return `GOAL\n${fixture.home} ${homeScore}-${awayScore} ${fixture.away}`;
}

export function formatLiveReply(fixture, liveInfo) {
  const { homeScore, awayScore, statusDetail, clock } = liveInfo || {};
  const scoreLine = `${fixture.home} ${homeScore ?? "?"}-${awayScore ?? "?"} ${fixture.away}`;
  const detailLine = [clock, statusDetail].filter(Boolean).join(" - ");
  return `LIVE\n${scoreLine}${detailLine ? `\n${detailLine}` : ""}`;
}

export function formatFinishedReply(fixture) {
  const label =
    fixture.status === "AET" ? "FULL TIME (AET)" :
    fixture.status === "PEN" ? "FULL TIME (Penalties)" :
    "FULL TIME";
  const h = fixture.final_home_score;
  const a = fixture.final_away_score;
  return `${label}\n${fixture.home} ${h ?? "?"}-${a ?? "?"} ${fixture.away}`;
}

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

export function formatCardsReply(fixture, cardPlays) {
  if (!cardPlays || cardPlays.length === 0) {
    return `CARDS\n${fixture.home} vs ${fixture.away}\nNo cards yet.`;
  }
  const lines = [`CARDS\n${fixture.home} vs ${fixture.away}`];
  for (const play of cardPlays) {
    const min = play.clock?.displayValue || "?'";
    const team = play.team?.displayName || "";
    const player = play.participants?.[0]?.athlete?.displayName || extractNameFromText(play.text) || "Unknown";
    const kind = play.redCard === true ? "RED" : "YELLOW";
    lines.push(`${min} ${kind} - ${player}${team ? ` (${team})` : ""}`);
  }
  return lines.join("\n");
}

export function formatSubsReply(fixture, subPlays) {
  if (!subPlays || subPlays.length === 0) {
    return `SUBSTITUTIONS\n${fixture.home} vs ${fixture.away}\nNone yet.`;
  }
  const lines = [`SUBSTITUTIONS\n${fixture.home} vs ${fixture.away}`];
  for (const play of subPlays) {
    const min = play.clock?.displayValue || "?'";
    const team = play.team?.displayName || "";
    const inPlayer = play.participants?.find((p) => p.type?.text === "SubstituteIn")?.athlete?.displayName;
    const outPlayer = play.participants?.find((p) => p.type?.text === "SubstituteOut")?.athlete?.displayName;
    const desc = inPlayer && outPlayer ? `${inPlayer} on for ${outPlayer}` : play.text || "Substitution";
    lines.push(`${min} ${desc}${team ? ` (${team})` : ""}`);
  }
  return lines.join("\n");
}

export function formatNextReply(fixtures, term) {
  if (!fixtures || fixtures.length === 0) {
    return term ? `No upcoming fixture found for "${term}".` : `No upcoming fixtures scheduled.`;
  }
  const header = term ? `NEXT - ${term}` : `NEXT UP`;
  const lines = [header];
  for (const f of fixtures) {
    lines.push(`${f.home} vs ${f.away}`);
    lines.push(`   ${kickoffET(f.kickoff_utc)} | ${f.round}`);
  }
  return lines.join("\n");
}

export function formatTodayReply(fixtures) {
  return formatDailySchedule(fixtures, "Today");
}

export function formatStatusReply({ gamesToday, gameImminent, statusCounts, muted }) {
  const counts = (statusCounts || []).map((r) => `  ${r.status}: ${r.cnt}`).join("\n") || "  (none)";
  return `BOT STATUS\ngames_today:    ${gamesToday}\ngame_imminent:  ${gameImminent}\nmuted:          ${muted ? "yes" : "no"}\n\nFixtures by status:\n${counts}`;
}

export function formatAdminFixtureList(fixtures, label) {
  if (!fixtures || fixtures.length === 0) {
    return `${label}: no fixtures found.`;
  }
  const lines = [`${label} (${fixtures.length}):`];
  for (const f of fixtures) {
    lines.push(`  [${f.id}] ${f.home} vs ${f.away} - ${f.status} - ${kickoffET(f.kickoff_utc)}`);
  }
  return lines.join("\n");
}

export function formatRefreshReply(count, date) {
  return `Refreshed ${date} from ESPN: ${count} fixture(s) upserted.`;
}

export function formatReconcileReply(results) {
  if (!results || results.length === 0) {
    return `Nothing to reconcile — no stuck fixtures found.`;
  }
  const lines = [`RECONCILE (${results.length} fixture(s)):`];
  for (const r of results) {
    lines.push(`  [${r.id}] ${r.home} vs ${r.away}: ${r.before} -> ${r.after}${r.note ? ` (${r.note})` : ""}`);
  }
  return lines.join("\n");
}

export function formatFollowReply(action, team, list) {
  const listLine = list.length ? list.join(", ") : "(none)";
  return `${action === "add" ? "Added" : "Removed"} "${team}". Current overrides: ${listLine}`;
}

export function formatMuteReply(minutes) {
  if (minutes == null) return `Unmuted — automated live posts will resume immediately.`;
  return `Muted for ${minutes} minute(s) — automated live posts (kickoff/goal/HT/FT) are paused. Commands still work.`;
}

export function formatNoMatchReply(term) {
  return term ? `No match found for "${term}".` : `No match is live right now, and I couldn't find a recent one.`;
}

export function formatAmbiguousReply(candidates, commandHint) {
  const MAX_LISTED = 8;
  const shown = candidates.slice(0, MAX_LISTED).map((f) => `  ${f.home} vs ${f.away}`);
  const extra = candidates.length - shown.length;
  const lines = [`Multiple matches live right now:`, ...shown];
  if (extra > 0) lines.push(`  ...and ${extra} more`);
  lines.push(`Try "${commandHint} <team name>" to pick one.`);
  return lines.join("\n");
}

export function formatCommandHelp(isAdmin = false) {
  let msg = `BOT COMMANDS
live          - score/status of the live match(es)
live <team>   - status of a specific match
stats         - stats for the active or most recent match
stats <team>  - stats for a specific match
goals         - goals so far in the active/most recent match
goals <team>  - goals for a specific match
cards <team>  - yellow/red cards for a match
subs <team>   - substitutions for a match
next          - next 5 upcoming fixtures
next <team>   - next fixture for a team
today         - all matches today
!help         - this message`;

  if (isAdmin) {
    msg += `

ADMIN COMMANDS
!admin fixtures [date]   - list fixtures (YYYY-MM-DD, default today)
!admin refresh           - re-fetch today's fixtures from ESPN
!admin reconcile         - re-check stuck LIVE/HT fixtures against ESPN
!admin status            - KV flags + fixture status counts
!admin follow <team>     - add a team to the dynamic follow list
!admin unfollow <team>   - remove a team from the dynamic follow list
!admin mute <minutes>    - pause automated live posts
!admin unmute            - resume automated live posts
!admin run <job>         - manually run daily/hourly/midnight/live`;
  }
  return msg;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatStatsBlock(stats) {
  if (!stats || stats.length < 2) return null;

  const h = stats.find((t) => t.homeAway === "home") || stats[0];
  const a = stats.find((t) => t.homeAway === "away") || stats[1];

  const STAT_DEFS = [
    { label: "Possession",  aliases: ["possessionpct", "possession", "ballpossession", "possession%"] },
    { label: "Shots",       aliases: ["totalshots", "shotstotal", "shots"] },
    { label: "On Target",   aliases: ["shotsontarget", "shotsongoal", "ontargetscoringatt", "totalshotsontarget"] },
    { label: "Corners",     aliases: ["cornerkicks", "wontcorners", "corners", "cornerkicksearned"] },
    { label: "Fouls",       aliases: ["fouls", "foulscommitted", "foulscommited"] },
    { label: "Yellow Cards", aliases: ["yellowcards", "totalyellowcards"] },
    { label: "Red Cards",   aliases: ["redcards", "totalredcards"] },
    { label: "Offsides",    aliases: ["offsides", "totaloffsides"] },
  ];

  const rows = [];
  for (const def of STAT_DEFS) {
    const hVal = findStat(h, def.aliases);
    const aVal = findStat(a, def.aliases);
    if (hVal == null && aVal == null) continue;
    rows.push(`${padLabel(def.label)} ${hVal ?? "-"} - ${aVal ?? "-"}`);
  }

  if (rows.length === 0) return null;
  return `STATS\n` + rows.join("\n");
}

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
