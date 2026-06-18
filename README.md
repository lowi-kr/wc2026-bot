# ⚽ FIFA World Cup 2026 — GroupMe Bot

This bot automatically posts World Cup 2026 match updates to a GroupMe group chat — goals, cards, substitutions, half-time scores, full-time results, and daily schedules. It runs entirely in the cloud, 24/7, with no computer needed after setup.

---

## What the bot posts

- 📅 The full group stage schedule (once, when you first set it up)
- 📅 Tomorrow's matches every morning at 8AM UTC (during the knockout stage)
- 🚨 A kickoff alert when a match starts
- ⚽ Every goal (with scorer and assist)
- 🟨🟥 Yellow and red cards
- 🔄 Substitutions
- 📺 VAR decisions
- 🔔 Half-time score
- 🏁 Full-time result with stats (possession, shots, corners, fouls)

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
| **API-Football** | Provides live match data | Free (100 req/day) |

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

### API-Football
1. Go to [dashboard.api-football.com/register](https://dashboard.api-football.com/register)
2. Create a free account
3. After logging in, find your **API Key** on the dashboard home page
4. Copy it and save it somewhere (like Notepad) — you'll need it later

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

### 4c — Connect your GitHub repo to Cloudflare Workers

This is what makes Cloudflare automatically redeploy the bot every time you change the code on GitHub — no extra tools needed.

1. In the Cloudflare dashboard, click **Workers & Pages** in the left sidebar
2. Click **Create**
3. Click the **Pages** tab, then click **Connect to Git**
4. Click **Connect GitHub** and authorize Cloudflare to access your GitHub account
5. Find and select your `wc2026-bot` repository
6. Click **Begin setup**
7. On the build settings page:
   - **Framework preset**: None
   - **Build command**: `npm ci && npx wrangler deploy`
   - **Build output directory**: leave blank
8. Expand **Environment variables (advanced)** and add the following — these are the values Cloudflare needs at build time and runtime:

| Variable name | Value | Type |
|--------------|-------|------|
| `D1_DATABASE_ID` | your database ID from Step 4a | Plain text |
| `API_FOOTBALL_KEY` | your API-Football key from Step 1 | **Encrypt** |
| `GROUPME_BOT_ID` | your GroupMe bot ID from Step 3 | **Encrypt** |

> For `API_FOOTBALL_KEY` and `GROUPME_BOT_ID`, tick **Encrypt** before saving so they're stored securely and never shown again.

9. Click **Save and Deploy**

Cloudflare will now build and deploy the bot. The first deploy takes about a minute. You'll see a success message when it's done.

From this point on, every time you edit any file on GitHub and commit, Cloudflare automatically redeploys within a minute — no terminal, no manual steps.

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

**During the group stage (June 11–26):**
- Tracks matches involving Spain, France, England, Argentina, Portugal, and USA only
- Checks every minute if any tracked match is currently live
- If no match is active, it does nothing and uses zero API quota
- When a match is live, it polls for new events and posts them to GroupMe

**From June 27 onward (knockout stage):**
- Every morning at 8AM UTC, the bot posts the next day's full match schedule
- All knockout matches are tracked regardless of which teams are playing

---

## Troubleshooting

**The bot isn't posting anything**
- Go to Cloudflare Dashboard → Workers & Pages → wc2026-bot → **Logs** to see errors
- Double-check that `API_FOOTBALL_KEY` and `GROUPME_BOT_ID` were entered correctly in Step 4c

**The deploy failed**
- Go to your Worker page → **Deployments** tab to see the error
- Most common cause: a variable in Step 4c is missing or has a typo

**A country isn't being tracked**
- API-Football uses `"United States"` not `"USA"` — check the Country Filter section below

**I want to re-post the group stage schedule**
- Visit `?action=init` again — it won't re-post if it already ran
- To force it: go to the D1 Console (Step 4b) and run:
  `DELETE FROM bot_state WHERE key = 'group_schedule_posted';`
  Then visit `?action=init` again

---

## Manual triggers

You can trigger bot actions by visiting these URLs in your browser:

| URL | What it does |
|-----|-------------|
| `?action=init` | Posts the group stage schedule (run once at setup) |
| `?action=daily` | Posts tomorrow's schedule right now |
| `?action=live` | Runs the live match poller right now |
| `?action=reset_fixture&id=FIXTURE_ID` | Resets a match so it re-posts (for testing) |

---

## Country Filter

The file `src/countries.js` controls which teams are tracked during the group stage.

**To follow ALL group stage matches:** delete `src/countries.js` from your GitHub repo (open the file on GitHub → click the trash icon → commit). The bot detects it's gone and tracks every match automatically.

**To change the list:** open `src/countries.js` on GitHub, click the pencil icon to edit, update the names, and click **Commit changes**. The bot redeploys automatically within a minute.

Team names must match exactly how API-Football spells them:
- ✅ `"United States"` not `"USA"`
- ✅ `"South Korea"` not `"Korea"`

If unsure, you can look up the exact name by visiting:
`https://v3.football.api-sports.io/teams?league=1&season=2026`
with your API key in the header `x-apisports-key`.

---

## Project structure

```
wc2026-bot/
├── src/
│   ├── index.js       # Main logic — cron jobs, live polling, match flow
│   ├── api.js         # Fetches data from API-Football
│   ├── db.js          # Reads and writes to the Cloudflare D1 database
│   ├── formatter.js   # Turns match data into GroupMe messages
│   ├── groupme.js     # Sends messages to GroupMe
│   └── countries.js   # Group stage country filter (delete to track all teams)
├── schema.sql          # Database table definitions (you ran this in Step 4b)
└── wrangler.toml       # Cloudflare Workers configuration
```

---

## License

MIT — free to use, modify, and share.
