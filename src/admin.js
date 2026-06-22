/**
 * admin.js — Password-protected dashboard for the WC2026 bot
 *
 * Routes handled (all under /admin, wired in index.js):
 *   GET  /admin              — dashboard page (requires auth cookie)
 *   POST /admin/login        — checks password, sets auth cookie
 *   POST /admin/logout       — clears auth cookie
 *   POST /admin/override     — flips games_today / game_imminent flags
 *   POST /admin/refresh      — re-fetches today's fixtures from ESPN
 *   POST /admin/reset        — resets a single fixture (status + seen_events)
 *   POST /admin/run          — manually runs an existing job (daily/hourly/live/midnight)
 *
 * Auth model: a single shared password (env.DASHBOARD_PASSWORD) checked
 * against a cookie holding a signed-ish token (HMAC over a fixed secret +
 * day, using the password itself as the key — good enough for a private,
 * single-user dashboard; this is NOT meant to gate anything more sensitive
 * than "don't let randoms flip my bot's flags").
 */

import {
  getFixturesByDate,
  getActiveFixtures,
  getRecentLogs,
  logEvent,
  upsertFixtures,
} from "./db.js";
import { fetchFixturesByDate } from "./api.js";

const COOKIE_NAME = "wc2026_admin";
const KV_GAMES_TODAY = "games_today";
const KV_GAME_IMMINENT = "game_imminent";

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function handleAdminRequest(request, env, ctx, url, jobFns) {
  const path = url.pathname;

  if (path === "/admin/login" && request.method === "POST") {
    return handleLogin(request, env);
  }

  if (path === "/admin/logout" && request.method === "POST") {
    return handleLogout();
  }

  // Everything else under /admin requires auth
  const authed = await isAuthed(request, env);

  if (path === "/admin" && request.method === "GET") {
    if (!authed) return renderLoginPage();
    return renderDashboard(env);
  }

  if (!authed) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (path === "/admin/override" && request.method === "POST") {
    return handleOverride(request, env);
  }
  if (path === "/admin/refresh" && request.method === "POST") {
    return handleRefresh(env);
  }
  if (path === "/admin/reset" && request.method === "POST") {
    return handleReset(request, env);
  }
  if (path === "/admin/run" && request.method === "POST") {
    return handleRun(request, env, ctx, jobFns);
  }

  return new Response("Not found", { status: 404 });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function signToken(password, dayStr) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(dayStr));
  return bufToHex(sig);
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

async function isAuthed(request, env) {
  if (!env.DASHBOARD_PASSWORD) {
    // Misconfigured — fail closed.
    return false;
  }
  const cookie = getCookie(request, COOKIE_NAME);
  if (!cookie) return false;
  const expected = await signToken(env.DASHBOARD_PASSWORD, todayStr());
  return timingSafeEqual(cookie, expected);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

async function handleLogin(request, env) {
  if (!env.DASHBOARD_PASSWORD) {
    return new Response("Dashboard password not configured.", { status: 500 });
  }
  const form = await request.formData();
  const password = form.get("password") || "";

  if (!timingSafeEqual(password, env.DASHBOARD_PASSWORD)) {
    return renderLoginPage("Incorrect password.");
  }

  const token = await signToken(env.DASHBOARD_PASSWORD, todayStr());
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/admin",
      "Set-Cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
    },
  });
}

function handleLogout() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/admin",
      "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    },
  });
}

// ─── Action handlers ──────────────────────────────────────────────────────────

async function handleOverride(request, env) {
  const form = await request.formData();
  const flag = form.get("flag");
  const value = form.get("value");

  if (![KV_GAMES_TODAY, KV_GAME_IMMINENT].includes(flag) || !["0", "1"].includes(value)) {
    return new Response("Bad request", { status: 400 });
  }

  await env.KV.put(flag, value, { expirationTtl: 60 * 60 * 26 });
  await logEvent(env.DB, "info", `[manual override] ${flag} set to ${value} via dashboard`);

  return redirectToAdmin();
}

async function handleRefresh(env) {
  try {
    const today = utcDate(0);
    const raw = await fetchFixturesByDate(env, today, undefined);
    await upsertFixtures(env.DB, raw);
    await logEvent(
      env.DB,
      "info",
      `[manual refresh] re-fetched ${raw.length} fixture(s) for ${today} from ESPN`
    );
  } catch (err) {
    await logEvent(env.DB, "error", `[manual refresh] failed: ${err.message}`);
  }
  return redirectToAdmin();
}

async function handleReset(request, env) {
  const form = await request.formData();
  const id = form.get("id");
  if (!id) return new Response("Missing fixture id", { status: 400 });

  await env.DB.prepare("DELETE FROM seen_events WHERE fixture_id = ?").bind(id).run();
  await env.DB.prepare("UPDATE fixtures SET status = 'NS' WHERE id = ?").bind(id).run();
  await logEvent(env.DB, "info", `[manual reset] fixture ${id} reset to NS via dashboard`);

  return redirectToAdmin();
}

async function handleRun(request, env, ctx, jobFns) {
  const form = await request.formData();
  const job = form.get("job");

  // jobFns is passed in from index.js (runDailyJob, runHourlyCheck, etc.)
  // rather than imported here, to avoid a circular import — index.js
  // already imports this file to wire up the /admin routes.
  const jobs = {
    daily: () => jobFns.runDailyJob(env, true),
    hourly: () => jobFns.runHourlyCheck(env),
    midnight: () => jobFns.runMidnightCheck(env),
    live: () => jobFns.runLivePolling(env),
  };

  if (!jobs[job]) return new Response("Unknown job", { status: 400 });

  await logEvent(env.DB, "info", `[manual run] triggered "${job}" via dashboard`);
  await jobs[job]();

  return redirectToAdmin();
}

function redirectToAdmin() {
  return new Response(null, { status: 302, headers: { Location: "/admin" } });
}

function utcDate(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderLoginPage(error) {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WC2026 Bot — Admin</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="login-wrap">
    <h1>WC2026 Bot</h1>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <form method="POST" action="/admin/login">
      <input type="password" name="password" placeholder="Dashboard password" autofocus required>
      <button type="submit">Log in</button>
    </form>
  </div>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function renderDashboard(env) {
  const today = utcDate(0);

  const [fixturesToday, activeFixtures, gamesToday, gameImminent, logs] = await Promise.all([
    getFixturesByDate(env.DB, today),
    getActiveFixtures(env.DB),
    env.KV.get(KV_GAMES_TODAY),
    env.KV.get(KV_GAME_IMMINENT),
    getRecentLogs(env.DB, 100),
  ]);

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WC2026 Bot — Admin</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>WC2026 Bot — Dashboard</h1>
      <form method="POST" action="/admin/logout"><button class="link-btn" type="submit">Log out</button></form>
    </header>

    <section class="card">
      <h2>Flags</h2>
      <div class="flags">
        <div class="flag-row">
          <span class="flag-name">games_today</span>
          <span class="badge ${gamesToday === "1" ? "on" : "off"}">${gamesToday ?? "unset"}</span>
          <form method="POST" action="/admin/override" class="inline-form">
            <input type="hidden" name="flag" value="${KV_GAMES_TODAY}">
            <input type="hidden" name="value" value="1">
            <button type="submit">Force ON</button>
          </form>
          <form method="POST" action="/admin/override" class="inline-form">
            <input type="hidden" name="flag" value="${KV_GAMES_TODAY}">
            <input type="hidden" name="value" value="0">
            <button type="submit" class="secondary">Force OFF</button>
          </form>
        </div>
        <div class="flag-row">
          <span class="flag-name">game_imminent</span>
          <span class="badge ${gameImminent === "1" ? "on" : "off"}">${gameImminent ?? "unset"}</span>
          <form method="POST" action="/admin/override" class="inline-form">
            <input type="hidden" name="flag" value="${KV_GAME_IMMINENT}">
            <input type="hidden" name="value" value="1">
            <button type="submit">Force ON</button>
          </form>
          <form method="POST" action="/admin/override" class="inline-form">
            <input type="hidden" name="flag" value="${KV_GAME_IMMINENT}">
            <input type="hidden" name="value" value="0">
            <button type="submit" class="secondary">Force OFF</button>
          </form>
        </div>
      </div>
      <p class="hint">If the bot thinks there's no game but you know there is, hit "Force ON" on
      <code>game_imminent</code> — it'll start live-polling within a minute regardless of what the
      automated checks decided.</p>
    </section>

    <section class="card">
      <h2>Today's fixtures (${escapeHtml(today)})</h2>
      ${renderFixturesTable(fixturesToday)}
    </section>

    ${activeFixtures.length > 0 ? `
    <section class="card">
      <h2>Currently active (within polling window)</h2>
      ${renderFixturesTable(activeFixtures)}
    </section>` : ""}

    <section class="card">
      <h2>Manual actions</h2>
      <div class="actions">
        <form method="POST" action="/admin/refresh" class="inline-form">
          <button type="submit">Refresh today's fixtures from ESPN</button>
        </form>
        <form method="POST" action="/admin/run" class="inline-form">
          <input type="hidden" name="job" value="midnight">
          <button type="submit">Run midnight check</button>
        </form>
        <form method="POST" action="/admin/run" class="inline-form">
          <input type="hidden" name="job" value="hourly">
          <button type="submit">Run hourly check</button>
        </form>
        <form method="POST" action="/admin/run" class="inline-form">
          <input type="hidden" name="job" value="live">
          <button type="submit">Run live poll now</button>
        </form>
        <form method="POST" action="/admin/run" class="inline-form">
          <input type="hidden" name="job" value="daily">
          <button type="submit">Post tomorrow's schedule now</button>
        </form>
      </div>
      <h3>Reset a fixture</h3>
      <form method="POST" action="/admin/reset" class="inline-form">
        <input type="text" name="id" placeholder="Fixture ID" required>
        <button type="submit" class="secondary">Reset</button>
      </form>
    </section>

    <section class="card">
      <h2>Recent activity</h2>
      <div class="log">
        ${logs.length === 0 ? "<p class='hint'>No log entries yet.</p>" : logs.map(renderLogLine).join("")}
      </div>
    </section>
  </div>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function renderFixturesTable(fixtures) {
  if (!fixtures || fixtures.length === 0) {
    return "<p class='hint'>None found.</p>";
  }
  const rows = fixtures
    .map(
      (f) => `<tr>
        <td>${escapeHtml(f.home)} vs ${escapeHtml(f.away)}</td>
        <td>${escapeHtml(f.round)}</td>
        <td>${escapeHtml(new Date(f.kickoff_utc).toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" }))}</td>
        <td><span class="status-pill">${escapeHtml(f.status)}</span></td>
        <td><code>${f.id}</code></td>
      </tr>`
    )
    .join("");
  return `<table>
    <thead><tr><th>Match</th><th>Round</th><th>Kickoff (ET)</th><th>Status</th><th>ID</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderLogLine(entry) {
  const cls = entry.level === "error" ? "log-error" : entry.level === "warn" ? "log-warn" : "log-info";
  const time = new Date(entry.ts).toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" });
  return `<div class="log-line ${cls}"><span class="log-time">${escapeHtml(time)}</span> ${escapeHtml(entry.message)}</div>`;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const BASE_CSS = `
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f1115;
    color: #e6e8eb;
    margin: 0;
    padding: 0;
  }
  .wrap { max-width: 880px; margin: 0 auto; padding: 24px 16px 64px; }
  .login-wrap {
    max-width: 320px; margin: 100px auto; text-align: center;
  }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
  h1 { font-size: 22px; margin: 0; }
  h2 { font-size: 16px; margin: 0 0 12px; color: #9aa3af; text-transform: uppercase; letter-spacing: 0.04em; }
  h3 { font-size: 14px; margin: 16px 0 8px; color: #9aa3af; }
  .card {
    background: #161922; border: 1px solid #262b36; border-radius: 10px;
    padding: 18px; margin-bottom: 18px;
  }
  .flag-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .flag-name { font-family: monospace; min-width: 140px; }
  .badge { padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; }
  .badge.on { background: #1f4d2e; color: #6ee08a; }
  .badge.off { background: #4d1f1f; color: #e08a8a; }
  .hint { color: #8b94a3; font-size: 13px; line-height: 1.5; }
  code { background: #21252f; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #262b36; }
  th { color: #8b94a3; font-weight: 500; font-size: 11px; text-transform: uppercase; }
  .status-pill { background: #21252f; padding: 2px 8px; border-radius: 10px; font-size: 11px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
  form.inline-form { display: inline; }
  button {
    background: #2d6cdf; color: white; border: none; padding: 8px 14px;
    border-radius: 6px; font-size: 13px; cursor: pointer;
  }
  button:hover { background: #2559b8; }
  button.secondary { background: #2a2f3a; color: #cdd2da; }
  button.secondary:hover { background: #353c4a; }
  button.link-btn { background: none; color: #8b94a3; text-decoration: underline; padding: 0; }
  input[type=password], input[type=text] {
    background: #0f1115; border: 1px solid #353c4a; color: #e6e8eb;
    padding: 8px 10px; border-radius: 6px; font-size: 14px; width: 100%; margin-bottom: 10px;
  }
  .error { color: #e08a8a; font-size: 13px; }
  .log { max-height: 360px; overflow-y: auto; font-family: monospace; font-size: 12px; }
  .log-line { padding: 4px 0; border-bottom: 1px solid #1e222c; }
  .log-time { color: #6b7280; margin-right: 8px; }
  .log-error { color: #e08a8a; }
  .log-warn { color: #e0c98a; }
`;