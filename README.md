# FIFA World Cup 2026 — GroupMe Bot

This bot automatically posts World Cup 2026 match updates to a GroupMe group chat — goals, half-time and full-time scores with stats, and daily schedules. It runs entirely in the cloud, 24/7, with no computer needed after setup.

You can also talk to it: type things like `live`, `stats`, `next`, or `!help` in the group chat and it replies on demand. See [Chat Commands](#chat-commands) below.

All messages are plain ASCII text (no emojis) since GroupMe's SMS fallback can't display them.

---

## What the bot posts

- The full group stage schedule (once, when you first set it up)
- Tomorrow's matches every morning at 8AM UTC (during the knockout stage)
- A kickoff alert when a match starts
- A message every time the score changes (goal), with scorer name when available
- Half-time score with match stats (possession, shots, corners, fouls, and more when available)
- Full-time result with match stats (occasionally followed by a short FINAL STATS message if stats weren't ready yet)

> Live cards, substitutions, and commentary aren't posted automatically as they happen — only goals get a live post. But you can ask for them on demand any time with `cards <team>` and `subs <team>` in the chat. See [Chat Commands](#chat-commands).

---

## Who this tracks

> **During the group stage**, the bot only tracks matches involving:
> **Spain, France, England, Argentina, Portugal, United States**
>
> **During the knockout stage**, the bot tracks every single match.
>
> Want to change this? See the [Country Filter](#country-filter) section at the bottom.

---

## Overview

You'll create accounts on three free websites and connect them together. No coding knowledge needed — just copy-pasting.

| Service | What it does | Cost |
|---------|-------------|------|
| **GitHub** | Stores the bot's code | Free |
| **Cloudflare** | Runs the bot 24/7 and auto-deploys when you change the code | Free |
| **ESPN** | Provides live match data (unofficial API, no key needed) | Free |

Everything sensitive (API keys, bot IDs) is stored inside Cloudflare — nothing private is ever written in the code files.

---

## Step 1 — Create your accounts

### GitHub
1. Go to [github.com](https://github.com) and click **Sign up**
2. Create a free account and verify your email

### Cloudflare
1. Go to [cloudflare.com](https://cloudflare.com) and click **Sign up**
2. Create a free account and verify your email
3. If it asks you to add a domain — click **Skip** or **Add later**, you don't need one

---

## Step 2 — Copy this project to your GitHub

This is a public repository and that's intentional — none of your private keys are ever stored in the code. All sensitive values go into Cloudflare (covered in the steps below), which keeps them encrypted and separate from the code.

1. Go to this project's GitHub page
2. Click the green **Use this template** button at the top right
3. Click **Create a new repository**
4. Give your copy a name like `wc2026-bot`
5. Leave it set to **Public**
6. Click **Create repository**

> **Don't see "Use this template"?** Click **Fork** instead, then go to your forked repo's **Settings** to rename it.

---

## Step 3 — Create a GroupMe Bot

A "bot" in GroupMe is an automated poster attached to one specific group.

1. Go to [dev.groupme.com](https://dev.groupme.com) and log in with your GroupMe account
2. Click **Bots** in the top menu
3. Click **Create Bot** and fill in:
   - **Bot Name**: anything, e.g. `WC2026 Updates`
   - **Group**: the GroupMe group where updates should be posted
   - **Callback URL**: `https://wc2026-bot.YOUR-NAME.workers.dev/groupme-webhook` — this is what lets the bot respond to chat commands like `live` or `stats`. You won't know your exact worker subdomain until after Step 4, so it's fine to leave this blank or as `https://example.com` for now and come back to fill it in once you have your real worker URL (Step 5 shows you where to find it)
4. Click **Submit**
5. You'll see your bot listed with a **Bot ID** — copy it and save it

> **Skipping the Callback URL?** The bot still works exactly the same for all its automatic posts (kickoffs, goals, schedules) — you just won't be able to type commands like `live` or `stats` into the group and get a reply. You can always come back and add it later.

---

## Step 4 — Set up Cloudflare

### 4a — Create the database

The bot uses a database to store the match schedule and avoid posting the same event twice.

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) and log in
2. In the left sidebar, click **Storage & Databases** → **D1 SQL Database**
3. Click **Create database**
4. Name it exactly: `wc2026`
5. Click **Create**
6. After it's created, look for **Database ID** on the page — it looks like `a1b2c3d4-e5f6-...`
7. Copy it and save it

### 4b — Run the database setup script

1. On the same database page, click the **Console** tab
2. Paste this entire block and click **Execute**:

```sql
CREATE TABLE IF NOT EXISTS fixtures (
  id          INTEGER PRIMARY KEY,
  home        TEXT    NOT NULL,
  away        TEXT    NOT NULL,
  kickoff_utc TEXT    NOT NULL,
  round       TEXT    NOT NULL,
  stage       TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'NS',
  posted_schedule  INTEGER NOT NULL DEFAULT 0,
  stats_pending    INTEGER NOT NULL DEFAULT 0,
  final_home_score INTEGER,
  final_away_score INTEGER
);

CREATE TABLE IF NOT EXISTS seen_events (
  fixture_id  INTEGER NOT NULL,
  event_key   TEXT    NOT NULL,
  PRIMARY KEY (fixture_id, event_key)
);

CREATE TABLE IF NOT EXISTS bot_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  level   TEXT NOT NULL,
  message TEXT NOT NULL
);
```

> **Already ran this before and just see a "table already exists" message?** That's fine — it means your tables exist already. If you set this up before `stats_pending`, `final_home_score`, or `final_away_score` existed, run these three lines too (paste one at a time — the Console's input box can mangle line breaks on a multi-line paste):
> ```sql
> ALTER TABLE fixtures ADD COLUMN stats_pending INTEGER NOT NULL DEFAULT 0;
> ```
> ```sql
> ALTER TABLE fixtures ADD COLUMN final_home_score INTEGER;
> ```
> ```sql
> ALTER TABLE fixtures ADD COLUMN final_away_score INTEGER;
> ```

3. You should see a success message. The database is ready.

### 4c — Create the KV namespace

KV is a second, simpler type of storage Cloudflare provides. The bot uses it to remember two small on/off flags — "is there a game today" and "is a game starting soon" — so the minute-by-minute check can usually skip all its work instantly instead of querying the database every single minute.

1. In the left sidebar, click **Storage & Databases** → **KV**
2. Click **Create a namespace**
3. Name it exactly: `wc2026-flags`
4. Click **Add**
5. After it's created, copy the **Namespace ID** shown on the page — it looks like `9f8e7d6c-...`
6. Save it alongside your database ID

### 4d — Connect your GitHub repo to Cloudflare Workers

This is what makes Cloudflare automatically redeploy the bot every time you change the code on GitHub — no extra tools needed.

1. In the Cloudflare dashboard, click **Workers & Pages** in the left sidebar
2. Click **Create**
3. Click the **Pages** tab, then click **Connect to Git**
4. Click **Connect GitHub** and authorize Cloudflare to access your GitHub account
5. Find and select your `wc2026-bot` repository
6. Click **Begin setup**
7. On the build settings page:
   - **Framework preset**: None
   - **Build command**: paste this exact command — it fills in your database and KV IDs at build time (because `wrangler.toml` can't safely contain them directly in a public repo), then deploys:
     ```
     sed -i "s|\$D1_DATABASE_ID|$D1_DATABASE_ID|g; s|\$KV_NAMESPACE_ID|$KV_NAMESPACE_ID|g" wrangler.toml && npx wrangler deploy
     ```
   - **Build output directory**: leave blank
8. Expand **Environment variables (advanced)** and add the following **build-time** variables — these are only used while Cloudflare is assembling your code, not while the bot is running:

| Variable name | Value | Type |
|--------------|-------|------|
| `D1_DATABASE_ID` | your database ID from Step 4a | Plain text |
| `KV_NAMESPACE_ID` | your namespace ID from Step 4c | Plain text |

9. Click **Save and Deploy**

Cloudflare will now build and deploy the bot. The first deploy takes about a minute. You'll see a success message when it's done.

From this point on, every time you edit any file on GitHub and commit, Cloudflare automatically redeploys within a minute — no terminal, no manual steps.

### 4e — Add the GroupMe secret (runtime variable)

This is different from Step 4d — those were build-time values used only during deployment. This one is read by the bot's code while it's actually running.

1. Go to **Workers & Pages** → click on **wc2026-bot**
2. Click the **Settings** tab, then **Variables and secrets** (you'll see a description: *"Define the environment variables and secrets for your Worker used at runtime"*)
3. Click **+ Add**
4. Choose type **Secret**
5. **Name**: `GROUPME_BOT_ID`
6. **Value**: your GroupMe bot ID from Step 3
7. Click **Save**

This triggers a small redeploy automatically so the bot picks up the new value.

### 4f — Add the admin dashboard password (runtime variable)

The bot includes a password-protected dashboard at `/admin` for checking on things and triggering jobs manually without using URL query parameters. This step turns it on.

1. Still on the **Variables and secrets** page from Step 4e, click **+ Add** again
2. Choose type **Secret**
3. **Name**: `DASHBOARD_PASSWORD`
4. **Value**: any password you'll remember — this is the only thing standing between someone and your dashboard, so don't reuse a password you use elsewhere, but it doesn't need to be elaborate
5. Click **Save**

If you skip this step, visiting `/admin` will always show "Unauthorized" — the dashboard fails closed without a password configured, on purpose.

### 4g — Add your GroupMe user ID (runtime variable, for admin chat commands)

This lets you use the `!admin` chat commands (like `!admin refresh` or `!admin reconcile`) directly in the group instead of opening `/admin`. Without it, everyone — including you — is refused when trying to use them, on purpose.

1. Find your GroupMe user ID: the simplest way is to send any message in the group after Step 3's Callback URL is set, then check **Recent activity** on `/admin` (or the Cloudflare Logs tab) for a `[command]` log line — GroupMe includes your `user_id` in every message it sends the bot
2. Still on the **Variables and secrets** page, click **+ Add**
3. Choose type **Secret**
4. **Name**: `ADMIN_GROUPME_USER_ID`
5. **Value**: your GroupMe user ID from step 1
6. Click **Save**

Only this one user ID will be able to run `!admin` commands; everyone else in the group can still use the regular commands (`live`, `stats`, `next`, etc.).

---

## Step 5 — Initialize the bot (run once)

This tells the bot to fetch the group stage schedule and post it to your GroupMe group.

1. In the Cloudflare dashboard, go to **Workers & Pages** → **wc2026-bot**
2. Click the **Triggers** tab and copy your worker URL — it looks like:
   `https://wc2026-bot.YOUR-NAME.workers.dev`
3. Open a new browser tab and visit:
   `https://wc2026-bot.YOUR-NAME.workers.dev/?action=init`
4. You should see: `Group stage initialized and schedule posted.`
5. Check your GroupMe — the full group stage schedule should have just been posted

**You're done.** The bot runs automatically from here with no computer needed.

---

## How the bot works day to day

The bot uses a 3-step check so it almost never has to do real work outside of match time:

1. **Midnight (UTC)** — looks at the schedule already stored in the database and asks "is there a tracked match today?" Saves a yes/no flag.
2. **Every hour** — if yesterday's flag was "no", this does nothing at all. If "yes", it asks "is a match starting in the next ~70 minutes, or already in progress?" Saves a second yes/no flag.
3. **Every minute** — if that second flag is "no", the bot exits instantly without contacting any API. If "yes", it checks the live score and posts updates.

This means on a day with no tracked matches, the bot makes a small number of cheap checks and otherwise does nothing — no wasted requests.

**What gets posted during a live match:**
- A kickoff message when the match starts
- A message each time the score changes (a goal), naming the scorer when available
- A half-time message with current stats (possession, shots, corners, fouls, and a few more when ESPN provides them)
- A full-time message with the final score and stats
- Occasionally, a short follow-up **FINAL STATS** message a minute or two after full time — ESPN's stats sometimes aren't ready the instant a match ends, so the bot retries a few times in the background rather than holding up the result itself

**During the group stage (June 11–26):** only matches involving Spain, France, England, Argentina, Portugal, and USA are tracked.

**From June 27 onward (knockout stage):** every match is tracked regardless of which teams are playing. Every morning at 8AM UTC the bot also posts the next day's schedule.

---

## Admin Dashboard

Visit `https://wc2026-bot.YOUR-NAME.workers.dev/admin` and log in with the `DASHBOARD_PASSWORD` you set in Step 4f. From there you can see, without needing to remember any URL query parameters:

- **Current flag states** — `games_today` and `game_imminent`, with one-click buttons to force either ON or OFF (useful if the bot's automatic checks got something wrong and you don't want to wait for the next hourly/midnight cycle)
- **Today's fixtures** and any **currently active** fixtures (within the live-polling window), with their status and ESPN fixture ID
- **Manual action buttons** — refresh today's fixtures from ESPN, or run the midnight/hourly/live jobs on demand
- **Reset a fixture** by ID — same as the `?action=reset_fixture` URL, but with a form instead of typing a query string
- **Recent activity log** — the last 100 things the bot has logged about its own decisions (kickoffs, goals, half-time/full-time posts, errors, manual overrides), newest first

This is meant for quick checks and nudges from your phone — it's not a replacement for Cloudflare's own Logs tab (Workers & Pages → wc2026-bot → Logs), which still has the full, unfiltered picture for deep debugging.

The login is a single shared password good for 24 hours at a time (you'll need to log in again the next day). It's intentionally simple — good enough to keep randoms out, not meant to gate anything more sensitive than your bot's own flags and fixture data.

---

## Chat Commands

Type these directly into the GroupMe group and the bot replies. Requires the Callback URL from Step 3 and, for admin commands, the `ADMIN_GROUPME_USER_ID` secret from Step 4g.

### Everyone in the group can use:

| Command | What it does |
|---------|-------------|
| `live` | Score/status of the live match(es) |
| `live <team>` | Status of a specific match |
| `stats` | Stats for the active or most recent match |
| `stats <team>` | Stats for a specific match |
| `goals` | Goals so far in the active or most recent match |
| `goals <team>` | Goals for a specific match |
| `cards <team>` | Yellow/red cards for a match |
| `subs <team>` | Substitutions for a match |
| `next` | Next 5 upcoming fixtures |
| `next <team>` | Next fixture for a specific team |
| `today` | All matches scheduled today |
| `!help` or `commands` | Shows this list (with the admin list too, if you're the admin) |

If a command needs a team but you don't name one, the bot picks the current live match — or asks you to specify if more than one match is live at once.

### Admin only (needs `ADMIN_GROUPME_USER_ID` set — see Step 4g):

All prefixed with `!admin` — these are a text-based alternative to the [Admin Dashboard](#admin-dashboard), handy when you're on your phone in the GroupMe app itself and don't want to switch to a browser.

| Command | What it does |
|---------|-------------|
| `!admin fixtures` | List today's fixtures (id, teams, status, kickoff time) |
| `!admin fixtures YYYY-MM-DD` | List fixtures for a specific date |
| `!admin refresh` | Re-fetch today's fixtures from ESPN into the database |
| `!admin reconcile` | Re-check any fixture stuck at LIVE/HT against ESPN and correct it |
| `!admin status` | KV flag states + fixture counts by status, as text |
| `!admin follow <team>` | Add a team to the group-stage follow list (on top of `countries.js`) without a redeploy |
| `!admin unfollow <team>` | Remove a team from the dynamic follow list |
| `!admin mute <minutes>` | Pause automated live posts (kickoff/goal/HT/FT) for N minutes — commands still work |
| `!admin unmute` | Resume automated live posts immediately |
| `!admin run <job>` | Manually run `daily`, `hourly`, `midnight`, or `live` — same as the dashboard's buttons |

Anyone who isn't the configured admin gets a plain "Not authorized" reply if they try an `!admin` command — nothing is silently ignored, so it's clear the command was seen but refused.

> **`!admin reconcile` caveat**: it can tell a stuck fixture is finished, but not whether it went to extra time or penalties (that distinction isn't available through the endpoint it uses). Anything it finds finished gets marked plain `FT`. If you know a specific match actually went to `AET`/`PEN`, correct that one fixture by hand afterward via the [Admin Dashboard](#admin-dashboard) or the D1 Console.

---

## Troubleshooting

Most of what's below can also be checked or triggered from the [Admin Dashboard](#admin-dashboard) at `/admin` instead of typing URLs — whichever's easier for you.

**The bot isn't posting anything**
- Visit `https://wc2026-bot.YOUR-NAME.workers.dev/?action=status` (or check the Flags section of `/admin`) — it shows the current `games_today` and `game_imminent` flags. If both say `0` and you know a tracked match is live, something is wrong with the schedule data (try `?action=init` again) or the country filter
- Go to Cloudflare Dashboard → Workers & Pages → wc2026-bot → **Logs** to see errors (or check **Recent activity** on `/admin` for a friendlier summary)
- Double-check that `GROUPME_BOT_ID` was entered correctly in Step 4e

**The deploy failed**
- Go to your Worker page → **Deployments** tab to see the error
- Most common cause: `D1_DATABASE_ID` or `KV_NAMESPACE_ID` is missing or has a typo in Step 4d

**A country isn't being tracked**
- ESPN uses `"United States"` not `"USA"` — check the Country Filter section below

**I want to re-post the group stage schedule**
- Visit `?action=init` again — it won't re-post if it already ran
- To force it: go to the D1 Console (Step 4b) and run:
  `DELETE FROM bot_state WHERE key = 'group_schedule_posted';`
  Then visit `?action=init` again

**I want to force the bot to check for a live match right now** (for testing, doesn't wait for the hourly/minute cycle)
- Visit `?action=live` (or click "Run live poll now" on `/admin`)

**I can't log into `/admin`, it just says Unauthorized**
- You haven't set the `DASHBOARD_PASSWORD` secret yet — see Step 4f. Without it, the dashboard fails closed on purpose rather than letting anyone in.

**I type `live`/`stats`/`!help` in the group and get no reply at all**
- Check the Callback URL is actually set at [dev.groupme.com](https://dev.groupme.com) on your bot, and matches your real worker URL exactly, ending in `/groupme-webhook` (see Step 3) — a blank or placeholder callback means GroupMe never tells your worker a message was sent
- Make sure you're posting in the same GroupMe group the bot is attached to — a bot only receives callbacks for its one assigned group, not DMs or other groups
- Check **Recent activity** on `/admin` (or `event_log` via the D1 Console) for a `[command]` line around when you sent the message — if there's nothing there at all, the callback likely isn't reaching the worker; if there's an error line, that'll say what went wrong

**`!admin` commands say "Not authorized" even though it's me typing them**
- You haven't set `ADMIN_GROUPME_USER_ID` yet, or it doesn't match your actual GroupMe user ID — see Step 4g for how to find it

**A live match isn't getting kickoff/goal/HT/FT posts even though the bot is otherwise working**
- Check the group isn't currently muted — send `!admin status` (or check `/admin`) to see; if `muted: yes`, send `!admin unmute`

---

## Manual triggers

You can trigger bot actions by visiting these URLs in your browser, or by using the buttons on the [Admin Dashboard](#admin-dashboard) at `/admin` instead:

| URL | What it does |
|-----|-------------|
| `?action=init` | Posts the group stage schedule (run once at setup) |
| `?action=daily` | Posts tomorrow's schedule right now |
| `?action=midnight` | Re-runs the midnight "any games today" check right now |
| `?action=hourly` | Re-runs the hourly "is a game imminent" check right now |
| `?action=live` | Forces a live-score check right now, bypassing the flags |
| `?action=status` | Shows the current `games_today` / `game_imminent` flag values |
| `?action=reset_fixture&id=FIXTURE_ID` | Resets a match (status, seen events, and any pending final-stats retry) so it re-posts from scratch — for testing |

---

## Country Filter

The file `src/countries.js` controls which teams are tracked during the group stage.

**To follow ALL group stage matches:** delete `src/countries.js` from your GitHub repo (open the file on GitHub → click the trash icon → commit). The bot detects it's gone and tracks every match automatically.

**To change the list permanently:** open `src/countries.js` on GitHub, click the pencil icon to edit, update the names, and click **Commit changes**. The bot redeploys automatically within a minute.

**To change it temporarily, without a redeploy:** the admin can send `!admin follow <team>` or `!admin unfollow <team>` in the chat (see [Chat Commands](#chat-commands)). This layers on top of `src/countries.js` rather than replacing it, takes effect immediately, and doesn't require touching GitHub — handy for "just this once, also track Brazil" without committing a code change.

Team names must match exactly how ESPN spells them:
- `"United States"` not `"USA"`
- `"South Korea"` not `"Korea"`

If unsure, you can check the exact spelling ESPN uses by visiting this link in your browser:
`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard`

---

## Project structure

```
wc2026-bot/
├── src/
│   ├── index.js       # Main logic — cron jobs, 3-tier polling, match flow
│   ├── commands.js    # GroupMe chat commands: public (live/stats/next/...) + !admin tier
│   ├── admin.js       # Password-protected dashboard at /admin
│   ├── api.js         # Fetches live data from ESPN's free unofficial API
│   ├── db.js          # Reads and writes to the Cloudflare D1 database
│   ├── formatter.js   # Turns match data into plain-ASCII GroupMe messages
│   ├── groupme.js     # Sends messages to GroupMe, strips non-ASCII characters, honors mute
│   └── countries.js   # Group stage country filter (delete to track all teams)
├── schema.sql          # Database table definitions (you ran this in Step 4b)
└── wrangler.toml       # Cloudflare Workers configuration
```

---

## License

MIT — free to use, modify, and share.
