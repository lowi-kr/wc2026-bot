// ─── Schedule Formatting ──────────────────────────────────────────────────────

/**
 * Format a list of fixtures into a schedule post.
 * @param {Array} fixtures - API-Football fixture objects
 * @param {string} dateLabel - e.g. "Today" or "Tomorrow (June 28)"
 */
export function formatSchedule(fixtures, dateLabel) {
  if (!fixtures || fixtures.length === 0) {
    return `📅 ${dateLabel}: No World Cup 2026 matches scheduled.`;
  }

  const lines = [`🏆 FIFA World Cup 2026 — ${dateLabel}'s Matches\n`];

  for (const f of fixtures) {
    const home = f.teams.home.name;
    const away = f.teams.away.name;
    const time = formatKickoffTime(f.fixture.date);
    const round = f.league.round || "";
    lines.push(`⚽ ${home} vs ${away}`);
    lines.push(`   🕐 ${time} | ${round}\n`);
  }

  return lines.join("\n");
}

/**
 * Format the full group stage schedule (chunked by date).
 */
export function formatGroupStageSchedule(fixtures) {
  if (!fixtures || fixtures.length === 0) {
    return "📅 No group stage fixtures found.";
  }

  // Group by date
  const byDate = {};
  for (const f of fixtures) {
    const date = f.fixture.date.split("T")[0];
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(f);
  }

  const lines = ["🏆 FIFA World Cup 2026 — Full Group Stage Schedule\n"];

  for (const date of Object.keys(byDate).sort()) {
    const label = formatDateLabel(date);
    lines.push(`📅 ${label}`);
    for (const f of byDate[date]) {
      const home = f.teams.home.name;
      const away = f.teams.away.name;
      const time = formatKickoffTime(f.fixture.date);
      const round = f.league.round || "";
      lines.push(`  ⚽ ${home} vs ${away} — ${time} | ${round}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Live Event Formatting ────────────────────────────────────────────────────

const EVENT_EMOJI = {
  Goal: "⚽",
  "Own Goal": "😬",
  "Penalty": "🎯",
  "Missed Penalty": "❌",
  "Yellow Card": "🟨",
  "Red Card": "🟥",
  "Yellow Red Card": "🟧",
  subst: "🔄",
};

/**
 * Format a single match event into a GroupMe message.
 */
export function formatEvent(event, homeTeam, awayTeam, homeScore, awayScore) {
  const minute = event.time.elapsed + (event.time.extra ? `+${event.time.extra}` : "") + "'";
  const team = event.team.name;
  const type = event.type;
  const detail = event.detail;
  const player = event.player?.name || "Unknown";
  const assist = event.assist?.name;

  let emoji = EVENT_EMOJI[detail] || EVENT_EMOJI[type] || "📌";
  let line = "";

  if (type === "Goal") {
    const scoreStr = `${homeScore}-${awayScore}`;
    if (detail === "Own Goal") {
      line = `😬 ${minute} OWN GOAL — ${player} (${team})\n${homeTeam} ${scoreStr} ${awayTeam}`;
    } else if (detail === "Penalty") {
      line = `🎯 ${minute} PENALTY GOAL — ${player} (${team})\n${homeTeam} ${scoreStr} ${awayTeam}`;
    } else {
      line = `⚽ ${minute} GOAL — ${player} (${team})${assist ? ` | Assist: ${assist}` : ""}\n${homeTeam} ${scoreStr} ${awayTeam}`;
    }
  } else if (type === "Card") {
    emoji = EVENT_EMOJI[detail] || "🟨";
    line = `${emoji} ${minute} ${detail.toUpperCase()} — ${player} (${team})`;
  } else if (type === "subst") {
    const playerOut = event.assist?.name || "?";
    line = `🔄 ${minute} SUB — ${player} ▶️ IN / ${playerOut} ◀️ OUT (${team})`;
  } else if (type === "Var") {
    line = `📺 ${minute} VAR — ${detail} | ${player} (${team})`;
  } else {
    line = `📌 ${minute} ${type}: ${detail} — ${player} (${team})`;
  }

  return line;
}

/**
 * Format a match kickoff announcement.
 */
export function formatKickoff(fixture) {
  const home = fixture.teams.home.name;
  const away = fixture.teams.away.name;
  const round = fixture.league.round || "World Cup 2026";
  return `🚨 KICK OFF!\n🏆 ${round}\n⚽ ${home} vs ${away}\n🕐 Match has started!`;
}

/**
 * Format a half-time message.
 */
export function formatHalfTime(fixture) {
  const home = fixture.teams.home.name;
  const away = fixture.teams.away.name;
  const hs = fixture.goals.home ?? 0;
  const as = fixture.goals.away ?? 0;
  return `🔔 HALF TIME\n${home} ${hs}-${as} ${away}`;
}

/**
 * Format a full-time summary message with top stats.
 */
export function formatFullTime(fixture, stats) {
  const home = fixture.teams.home.name;
  const away = fixture.teams.away.name;
  const hs = fixture.goals.home ?? 0;
  const as = fixture.goals.away ?? 0;
  const round = fixture.league.round || "World Cup 2026";

  const winner =
    hs > as ? `🏆 ${home} win!` : as > hs ? `🏆 ${away} win!` : "🤝 Draw!";

  let msg = `🏁 FULL TIME — ${round}\n${home} ${hs}-${as} ${away}\n${winner}`;

  if (stats && stats.length >= 2) {
    const homeStat = stats[0].statistics;
    const awayStat = stats[1].statistics;

    const getStat = (arr, type) =>
      arr.find((s) => s.type === type)?.value ?? "—";

    const hPoss = getStat(homeStat, "Ball Possession");
    const aPoss = getStat(awayStat, "Ball Possession");
    const hShots = getStat(homeStat, "Total Shots");
    const aShots = getStat(awayStat, "Total Shots");
    const hShotsOT = getStat(homeStat, "Shots on Goal");
    const aShotsOT = getStat(awayStat, "Shots on Goal");
    const hCorners = getStat(homeStat, "Corner Kicks");
    const aCorners = getStat(awayStat, "Corner Kicks");

    msg += `\n\n📊 Stats\n`;
    msg += `Possession:   ${hPoss} — ${aPoss}\n`;
    msg += `Shots:        ${hShots} — ${aShots}\n`;
    msg += `On Target:    ${hShotsOT} — ${aShotsOT}\n`;
    msg += `Corners:      ${hCorners} — ${aCorners}`;
  }

  return msg;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatKickoffTime(isoDate) {
  const d = new Date(isoDate);
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  });
}

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
