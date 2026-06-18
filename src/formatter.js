/**
 * formatter.js — Format all GroupMe messages
 * All times displayed in US Eastern (ET).
 *
 * ESPN play objects have a different shape than API-Football:
 *   play.type.text       — e.g. "Goal", "Yellow Card", "Substitution"
 *   play.clock.displayValue — e.g. "45'"
 *   play.participants[]  — array of { athlete: { displayName, id }, type: { text } }
 *   play.team.displayName
 *   play.text            — human-readable description ESPN generates (e.g. "Mbappé scores")
 */

const ET_TIMEZONE = "America/New_York";

// ─── Schedule Posts ───────────────────────────────────────────────────────────

export function formatGroupStageSchedule(fixtures, filtered, countries) {
  const lines = ["🏆 FIFA World Cup 2026 — Group Stage Schedule\n"];

  if (filtered) {
    lines.push(`👀 Tracking: ${countries.join(", ")}\n`);
  }

  if (!fixtures || fixtures.length === 0) {
    lines.push("No matching group stage fixtures found.");
    return lines.join("\n");
  }

  const byDate = groupByDate(fixtures);
  for (const date of Object.keys(byDate).sort()) {
    lines.push(`📅 ${readableDate(date)}`);
    for (const f of byDate[date]) {
      lines.push(`  ⚽ ${f.home} vs ${f.away}`);
      lines.push(`     🕐 ${kickoffET(f.kickoff_utc)} | ${f.round}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function formatDailySchedule(fixtures, dateLabel) {
  if (!fixtures || fixtures.length === 0) {
    return `📅 ${dateLabel}: No World Cup 2026 matches scheduled.`;
  }

  const lines = [`🏆 FIFA World Cup 2026\n📅 ${dateLabel}\n`];
  for (const f of fixtures) {
    lines.push(`⚽ ${f.home} vs ${f.away}`);
    lines.push(`   🕐 ${kickoffET(f.kickoff_utc)} | ${f.round}\n`);
  }
  return lines.join("\n").trimEnd();
}

// ─── Live Match Posts ─────────────────────────────────────────────────────────

export function formatKickoff(fixture) {
  return (
    `🚨 KICK OFF!\n` +
    `🏆 ${fixture.round}\n` +
    `⚽ ${fixture.home} vs ${fixture.away}\n` +
    `🕐 ${kickoffET(fixture.kickoff_utc)}`
  );
}

export function formatHalfTime(fixture, homeScore, awayScore) {
  return (
    `🔔 HALF TIME\n` +
    `${fixture.home} ${homeScore}–${awayScore} ${fixture.away}`
  );
}

export function formatFullTime(fixture, homeScore, awayScore, stats, statusShort) {
  const label =
    statusShort === "AET" ? "FULL TIME (AET)" :
    statusShort === "PEN" ? "FULL TIME (Penalties)" :
    "FULL TIME";

  const winner =
    homeScore > awayScore ? `🏆 ${fixture.home} win!` :
    awayScore > homeScore ? `🏆 ${fixture.away} win!` :
    "🤝 Draw";

  let msg =
    `🏁 ${label}\n` +
    `🏆 ${fixture.round}\n` +
    `${fixture.home} ${homeScore}–${awayScore} ${fixture.away}\n` +
    `${winner}`;

  // ESPN boxscore.teams returns [{team, statistics: [{name, displayValue}]}]
  if (stats && stats.length >= 2) {
    const getStat = (teamStats, name) => {
      const stats = teamStats?.statistics || [];
      return stats.find((s) => s.name === name)?.displayValue ?? "—";
    };

    const h = stats.find((t) => t.homeAway === "home") || stats[0];
    const a = stats.find((t) => t.homeAway === "away") || stats[1];

    msg +=
      `\n\n📊 Match Stats\n` +
      `Possession:  ${getStat(h, "possessionPct")} — ${getStat(a, "possessionPct")}\n` +
      `Shots:       ${getStat(h, "totalShots")} — ${getStat(a, "totalShots")}\n` +
      `On Target:   ${getStat(h, "shotsOnTarget")} — ${getStat(a, "shotsOnTarget")}\n` +
      `Corners:     ${getStat(h, "cornerKicks")} — ${getStat(a, "cornerKicks")}\n` +
      `Fouls:       ${getStat(h, "fouls")} — ${getStat(a, "fouls")}`;
  }

  return msg;
}

/**
 * Format a single ESPN play object into a GroupMe message.
 * ESPN play shape:
 *   play.type.text       — "Goal", "Yellow Card", "Red Card", "Substitution", "VAR"
 *   play.clock.displayValue — "34'"
 *   play.text            — ESPN's own description e.g. "Kylian Mbappé goal"
 *   play.participants[]  — [{athlete: {displayName}, type: {text: "Scorer"|"Assist"|...}}]
 *   play.team.displayName
 */
export function formatEvent(play, fixture, homeScore, awayScore) {
  const typeText = (play.type?.text || "").toLowerCase();
  const min      = play.clock?.displayValue || "?'";
  const team     = play.team?.displayName || "";
  const score    = `${homeScore}–${awayScore}`;

  // Find participants by role
  const scorer  = play.participants?.find((p) => p.type?.text === "Scorer")?.athlete?.displayName;
  const assist  = play.participants?.find((p) => p.type?.text === "Assist")?.athlete?.displayName;
  const subOn   = play.participants?.find((p) => p.type?.text === "Entering")?.athlete?.displayName;
  const subOff  = play.participants?.find((p) => p.type?.text === "Exiting")?.athlete?.displayName;
  const carded  = play.participants?.find((p) => p.type?.text === "Carded")?.athlete?.displayName;
  const anyPlayer = play.participants?.[0]?.athlete?.displayName || "Unknown";

  if (typeText.includes("goal")) {
    const isOG      = typeText.includes("own");
    const isPenalty = typeText.includes("penalty");
    const name      = scorer || anyPlayer;

    if (isOG) {
      return `😬 ${min} OWN GOAL — ${name} (${team})\n${fixture.home} ${score} ${fixture.away}`;
    }
    if (isPenalty) {
      return `🎯 ${min} PENALTY — ${name} (${team})\n${fixture.home} ${score} ${fixture.away}`;
    }
    return (
      `⚽ ${min} GOAL — ${name} (${team})` +
      (assist ? ` | Assist: ${assist}` : "") +
      `\n${fixture.home} ${score} ${fixture.away}`
    );
  }

  if (typeText.includes("yellow card")) {
    return `🟨 ${min} YELLOW CARD — ${carded || anyPlayer} (${team})`;
  }

  if (typeText.includes("red card")) {
    const emoji = typeText.includes("yellow") ? "🟧" : "🟥"; // second yellow vs straight red
    return `${emoji} ${min} RED CARD — ${carded || anyPlayer} (${team})`;
  }

  if (typeText.includes("substitution")) {
    const on  = subOn  || anyPlayer;
    const off = subOff || "?";
    return `🔄 ${min} SUB — ${on} ▶️ IN  /  ${off} ◀️ OUT  (${team})`;
  }

  if (typeText.includes("var")) {
    return `📺 ${min} VAR — ${play.text || typeText} (${team})`;
  }

  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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