# FIFA World Cup 2026 — GroupMe Bot

This bot automatically posts World Cup 2026 match updates to a GroupMe group chat — goals, half-time and full-time scores with stats, and daily schedules. It runs entirely in the cloud, 24/7, with no computer needed after setup.

All messages are plain ASCII text (no emojis) since GroupMe's SMS fallback can't display them.

---

## What the bot posts

- The full group stage schedule (once, when you first set it up)
- Tomorrow's matches every morning at 8AM UTC (during the knockout stage)
- A kickoff alert when a match starts
- A message every time the score changes (goal), with scorer name when available
- Half-time score with match stats (possession, shots, corners, fouls)
- Full-time result with match stats

> This bot does not currently post live cards, substitutions, or commentary — only goals, because no free, reliable source for live play-by-play commentary was available at setup time. See the note in `src/api.js` if you want to add a richer data source later (e.g. during the knockout rounds).

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
   - **Callback URL**: leave blank or type `https://example.com`
4. Click **Submit**
5. You'll see your bot listed with a **Bot ID** — copy it and save it

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
  posted_schedule INTEGER NOT NULL DEFAULT 0
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
```

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
- A half-time message with current stats (possession, shots, corners, fouls)
- A full-time message with the final score and stats

**During the group stage (June 11–26):** only matches involving Spain, France, England, Argentina, Portugal, and USA are tracked.

**From June 27 onward (knockout stage):** every match is tracked regardless of which teams are playing. Every morning at 8AM UTC the bot also posts the next day's schedule.

---

## Troubleshooting

**The bot isn't posting anything**
- Visit `https://wc2026-bot.YOUR-NAME.workers.dev/?action=status` — it shows the current `games_today` and `game_imminent` flags. If both say `0` and you know a tracked match is live, something is wrong with the schedule data (try `?action=init` again) or the country filter
- Go to Cloudflare Dashboard → Workers & Pages → wc2026-bot → **Logs** to see errors
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
- Visit `?action=live`

---

## Manual triggers

You can trigger bot actions by visiting these URLs in your browser:

| URL | What it does |
|-----|-------------|
| `?action=init` | Posts the group stage schedule (run once at setup) |
| `?action=daily` | Posts tomorrow's schedule right now |
| `?action=midnight` | Re-runs the midnight "any games today" check right now |
| `?action=hourly` | Re-runs the hourly "is a game imminent" check right now |
| `?action=live` | Forces a live-score check right now, bypassing the flags |
| `?action=status` | Shows the current `games_today` / `game_imminent` flag values |
| `?action=reset_fixture&id=FIXTURE_ID` | Resets a match so it re-posts (for testing) |

---

## Country Filter

The file `src/countries.js` controls which teams are tracked during the group stage.

**To follow ALL group stage matches:** delete `src/countries.js` from your GitHub repo (open the file on GitHub → click the trash icon → commit). The bot detects it's gone and tracks every match automatically.

**To change the list:** open `src/countries.js` on GitHub, click the pencil icon to edit, update the names, and click **Commit changes**. The bot redeploys automatically within a minute.

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
│   ├── api.js         # Fetches live data from ESPN's free unofficial API
│   ├── db.js          # Reads and writes to the Cloudflare D1 database
│   ├── formatter.js   # Turns match data into plain-ASCII GroupMe messages
│   ├── groupme.js     # Sends messages to GroupMe, strips any non-ASCII characters
│   └── countries.js   # Group stage country filter (delete to track all teams)
├── schema.sql          # Database table definitions (you ran this in Step 4b)
└── wrangler.toml       # Cloudflare Workers configuration
```

---

## License

MIT — free to use, modify, and share.