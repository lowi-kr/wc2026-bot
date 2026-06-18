/**
 * formatter.js — Format all GroupMe messages
 * All times displayed in US Eastern (ET).
 */

const ET_TIMEZONE = "America/New_York";

// ─── Schedule Posts ───────────────────────────────────────────────────────────

/**
 * Format the full group stage schedule (posted once).
 * @param {Array} fixtures - rows from D1
 * @param {boolean} filtered - whether a country filter is active
 * @param {string[]} countries - list of followed countries (for footer note)
 */
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

/**
 * Format tomorrow's schedule (daily knockout post).
 * @param {Array} fixtures - rows from D1
 * @param {string} dateLabel - e.g. "Tomorrow — Wednesday, July 1"
 */
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
    statusShort === "AET"
      ? "FULL TIME (AET)"
      : statusShort === "PEN"
      ? "FULL TIME (Penalties)"
      : "FULL TIME";

  const winner =
    homeScore > awayScore
      ? `🏆 ${fixture.home} win!`
      : awayScore > homeScore
      ? `🏆 ${fixture.away} win!`
      : "🤝 Draw";

  let msg =
    `🏁 ${label}\n` +
    `🏆 ${fixture.round}\n` +
    `${fixture.home} ${homeScore}–${awayScore} ${fixture.away}\n` +
    `${winner}`;

  if (stats && stats.length >= 2) {
    const h = stats[0].statistics;
    const a = stats[1].statistics;
    const get = (arr, type) => arr.find((s) => s.type === type)?.value ?? "—";

    msg +=
      `\n\n📊 Match Stats\n` +
      `Possession:  ${get(h, "Ball Possession")} — ${get(a, "Ball Possession")}\n` +
      `Shots:       ${get(h, "Total Shots")} — ${get(a, "Total Shots")}\n` +
      `On Target:   ${get(h, "Shots on Goal")} — ${get(a, "Shots on Goal")}\n` +
      `Corners:     ${get(h, "Corner Kicks")} — ${get(a, "Corner Kicks")}\n` +
      `Fouls:       ${get(h, "Fouls")} — ${get(a, "Fouls")}`;
  }

  return msg;
}

/**
 * Format a single match event (goal, card, sub, VAR).
 * Returns null for event types we don't want to post.
 */
export function formatEvent(event, fixture, homeScore, awayScore) {
  const min =
    event.time.elapsed + (event.time.extra ? `+${event.time.extra}` : "") + "'";
  const team = event.team.name;
  const player = event.player?.name || "Unknown";
  const assist = event.assist?.name;
  const type = event.type;
  const detail = event.detail;

  if (type === "Goal") {
    const score = `${homeScore}–${awayScore}`;
    if (detail === "Own Goal") {
      return `😬 ${min} OWN GOAL — ${player} (${team})\n${fixture.home} ${score} ${fixture.away}`;
    }
    if (detail === "Penalty") {
      return `🎯 ${min} PENALTY — ${player} (${team})\n${fixture.home} ${score} ${fixture.away}`;
    }
    return (
      `⚽ ${min} GOAL — ${player} (${team})` +
      (assist ? ` | Assist: ${assist}` : "") +
      `\n${fixture.home} ${score} ${fixture.away}`
    );
  }

  if (type === "Card") {
    const emoji =
      detail === "Red Card" ? "🟥" : detail === "Yellow Red Card" ? "🟧" : "🟨";
    return `${emoji} ${min} ${detail.toUpperCase()} — ${player} (${team})`;
  }

  if (type === "subst") {
    const off = assist || "?"; // API-Football puts the outgoing player in assist field
    return `🔄 ${min} SUB — ${player} ▶️ IN  /  ${off} ◀️ OUT  (${team})`;
  }

  if (type === "Var") {
    return `📺 ${min} VAR — ${detail} | ${player} (${team})`;
  }

  // Ignore anything else (e.g. "Missed Penalty" already captured as a goal event)
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function kickoffET(isoDate) {
  return new Date(isoDate).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: ET_TIMEZONE,
    timeZoneName: "short",
  });
}

function readableDate(dateStr) {
  return new Date(dateStr + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
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
