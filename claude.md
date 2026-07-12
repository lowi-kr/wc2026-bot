# CLAUDE.md — Project Context & Working Instructions

This file is for any AI assistant (Claude or otherwise) helping with this repo.
Read this before making changes. It explains what this project is, why it's
built the way it is, how I like to work, and what I don't want you to do.

---

## What this is

`wc2026-bot` is a FIFA World Cup 2026 GroupMe notification bot. It runs on
Cloudflare Workers (cron triggers + D1 + KV), pulls live match data from
ESPN's free unofficial API, and posts updates (kickoffs, goals, half-time,
full-time with stats) to a GroupMe group chat. It also listens for chat
commands (`live`, `stats`, `next`, `!admin ...`) via a GroupMe callback
webhook.

**This is a hobby/personal project, not a commercial product.** It exists so
I (and whoever's in the GroupMe group) don't have to check scores manually
during the tournament. Treat correctness and not-annoying-people as more
important than elegance or completeness.

## My goal / what "done" looks like

- The bot never misses a real event (kickoff, goal, HT, FT) for a match it's
  supposed to be tracking.
- It never spams the group — no duplicate posts, no noise from matches it
  shouldn't be tracking, no crash loops.
- When something breaks, it's diagnosable from `event_log` (D1) and/or the
  admin dashboard/chat commands, without needing to SSH into anything or dig
  through raw Cloudflare logs unless it's a genuinely deep issue.
- I can manage day-to-day stuff (check fixtures, refresh data, mute the bot,
  follow an extra team) via GroupMe chat or the `/admin` dashboard — not by
  editing code and redeploying for routine operations.

## Architecture at a glance

- **`index.js`** — Workers entry point. Cron handlers (midnight/hourly/minute
  polling tiers) and the live-match state machine (kickoff → goals → HT → FT).
- **`commands.js`** — all GroupMe chat command handling: public commands
  anyone in the group can use, and an `!admin`-prefixed tier gated to one
  GroupMe user ID (`ADMIN_GROUPME_USER_ID` secret).
- **`admin.js`** — password-protected web dashboard at `/admin` (same
  capabilities as chat admin commands, browser-based).
- **`api.js`** — all ESPN API calls live here. No API key needed.
- **`db.js`** — all D1 queries. `fixtures`, `seen_events`, `bot_state`,
  `event_log` tables.
- **`formatter.js`** — turns data into plain-ASCII GroupMe message text.
- **`groupme.js`** — actually posts to GroupMe; also the mute gate.
- **`countries.js`** — static group-stage follow list (delete to track
  everyone); `bot_state` holds a dynamic overlay on top of it.

Full setup/ops docs are in `README.md` — read that too if you need the
Cloudflare/GroupMe account-level setup steps, not just the code.

## Data flow / source of truth

- **ESPN's live `status` field is the only source of truth for whether a
  match is still in progress** — never re-derive "is this match over" from
  wall-clock time since kickoff. This bit us once already (see "Known
  history" below): a wall-clock cutoff killed live tracking mid-match.
- **The deployed Cloudflare bundle is the actual source of truth for what's
  running in production** — not this repo, not any chat summary, not my
  memory of what I asked for last time. If you have `workers_get_worker_code`
  or similar tool access, pull the live bundle and diff it against the repo
  before assuming either one is current. They have drifted before (a real
  incident, not hypothetical).
- **`event_log` (D1 table) is the bot's own structured log** — use it for
  "what did the bot decide and do" questions. It is NOT a substitute for
  Cloudflare's actual Workers invocation logs (`wrangler tail` / dashboard
  Logs tab) when you need platform-level detail (exceptions, subrequest
  counts, CPU time, raw request/response). Use the right one for the
  question being asked.

## Known history (so you don't re-diagnose from scratch)

- **Body-parsing race condition**: reading `request.json()` inside a detached
  `ctx.waitUntil()` after the response was already returned is unreliable on
  Workers — the body stream can be torn down. Fixed by parsing the body
  before responding. If a webhook/callback route is ever added and silently
  does nothing, check this first.
- **Wall-clock cutoffs for "is this match still live" are wrong.** Elapsed
  time since kickoff only grows; a long match (stoppage, extra time) can
  cross any fixed cutoff while genuinely still in progress, and once it does,
  the bot can never resume tracking it. ESPN's own status field doesn't have
  this problem — trust it instead.
- **The moment of kickoff itself is a gap between two otherwise-correct
  checks.** `runHourlyCheck` decides "is a match imminent" from two signals:
  ESPN already reporting `status === "in"`, or kickoff being within the next
  ~70 minutes. Right at kickoff, `minsUntil` can tip slightly negative
  (failing the forward check) before ESPN's own status has flipped to `"in"`
  yet (a real API lag, not hypothetical). Neither condition matches for that
  narrow window, `game_imminent` gets cleared, and the per-minute poller goes
  quiet right as the match starts — this is what silently delayed the kickoff
  post for Spain vs Belgium (2026-07-10) by 29 minutes, until someone manually
  ran `!admin run live`. Fixed with a ~20-minute lookback allowance alongside
  the existing forward window and ESPN-status check. If a similar "flag
  cleared at exactly the wrong moment" bug shows up elsewhere, look for the
  same pattern: a boundary condition where two independent checks both
  narrowly miss covering the same instant.
- **Unbounded "active fixtures" queries are dangerous.** A fixture stuck at
  `LIVE`/`HT` (from a bug, or from ESPN being flaky) that never gets
  reconciled will get re-checked on every single minute-poll forever if there's
  no lower bound on the query, burning through Cloudflare's per-invocation
  subrequest limit and starving whatever match is actually live that day.
  Always keep a sane lookback window (currently 4 hours) on any "what's
  active right now" query, even when the filter is otherwise
  status-based and "should" be sufficient on its own.
- **`ON CONFLICT DO NOTHING` is dangerous for schedule data that can be
  corrected upstream** (e.g. ESPN fixing a kickoff time). Prefer conditional
  updates that only refresh rows in a safe state (e.g. `status = 'NS'`).
- **GroupMe quirks**: plain ASCII only (SMS fallback renders emoji as
  `????`); a bare `help` is intercepted by GroupMe itself as a platform
  command, so the bot's help command is `!help`; `/v3/bots/post` returns
  `202`/`200` even for some invalid bot IDs, so HTTP status alone isn't proof
  of delivery.
- **ESPN's normalized scoreboard endpoint (used for daily fixture
  fetch/refresh) only exposes coarse `pre`/`in`/`post` status** — not enough
  to distinguish a plain FT from AET/PEN. Anything needing that distinction
  (goal detection, full-time messages) reads the richer play-by-play/summary
  endpoints instead. Don't assume the coarse endpoint has fields it doesn't.

## Conventions I want followed

- **Complete file rewrites, not diffs/snippets**, when handing me changed
  files. I'll do the copy-paste into my own editor/GitHub myself.
- **Only hand me the files that actually changed** — not a full re-zip of
  the repo, not files you didn't touch.
- **Validate every modified `.js` file with `node --check` before calling it
  done.** If it doesn't pass, it's not finished.
- **Clone the repo directly when you have the tooling to do it** (it's
  public specifically so this works) rather than working from pasted file
  contents — pasted contents go stale as soon as anything changes.
- **I push to GitHub myself.** Don't assume you have write/push access to
  the repo unless I've told you otherwise — check before assuming a commit
  went anywhere.
- **Nothing hardcoded in the committed files.** All secrets/config go through
  Cloudflare secrets/variables or GitHub Actions variables, never literal
  values in `.js`/`.toml` files that get committed.
- **Comment the "why," not just the "what,"** especially for anything that
  looks like it could plausibly be "simplified" back into a bug that was
  already fixed once (see "Known history" above). Future-me (or a future AI)
  should not have to rediscover the same incident twice.

## What I don't want

- Don't guess at what's deployed vs. what's in the repo vs. what's in a past
  chat summary — verify against the actual deployed bundle when you have the
  tooling to check. I've been burned by stale assumptions here before.
- Don't add features I didn't ask for "while you're in there." If you notice
  something else that looks broken or worth doing, tell me about it and let
  me decide — don't silently expand scope.
- Don't reach for a wall-clock/time-based heuristic as a shortcut for "is
  this thing still happening" when a real status/state field is available
  instead. This project has been bitten by that exact shortcut more than
  once.
- Don't quietly change user-facing message wording/formatting as a side
  effect of an unrelated fix. If a message's text or format needs to change,
  call it out explicitly so I notice it in the diff.
- Don't assume silence in logs means success. This bot has had more than one
  incident where something failed completely silently (see "Known history").
  If you're not sure something is actually working, say so rather than
  asserting it is.

## When I ask you to "review" this repo

Please specifically check for:
1. Any query or loop over "active"/"pending"/"stuck" data that has no upper
   AND lower bound — this is the failure mode that's bitten this project
   more than once.
2. Any place reading a request/response body after control has already
   returned to the caller (detached async work) — same category of bug as
   the webhook incident.
3. Whether the deployed Cloudflare bundle actually matches this repo's
   `main` branch, if you have tooling to check both.
4. Whether secrets/config are still only referenced via `env.*`, never
   literal values.
5. Whether new user-facing strings (GroupMe messages) are plain ASCII only.

You don't need to relitigate architecture decisions (Workers + D1 + KV, ESPN
as the data source, GroupMe as the messaging channel) unless I explicitly
ask — those are settled for this project.
