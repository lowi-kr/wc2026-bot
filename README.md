# ⚽ FIFA World Cup 2026 — GroupMe Bot

This bot automatically posts World Cup 2026 match updates to a GroupMe group chat — goals, cards, substitutions, half-time scores, full-time results, and daily schedules. It runs entirely in the cloud, 24/7, with no computer needed after setup.

---

## What the bot posts

- 📅 The full group stage schedule (once, when you first set it up)
- 📅 Tomorrow's matches every morning at 8AM (during the knockout stage)
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

## Overview of what you'll set up

You'll create accounts on three free websites and connect them together. No coding knowledge is needed — just copy-pasting.

| Service | What it does | Cost |
|---------|-------------|------|
| **GitHub** | Stores the bot's code and auto-deploys it | Free |
| **Cloudflare** | Runs the bot 24/7 in the cloud | Free |
| **API-Football** | Provides live match data | Free (100 req/day) |

Everything sensitive (passwords, keys) is stored securely in GitHub and Cloudflare — nothing private is ever written in the code files.

---

## Step 1 — Create your accounts

### GitHub
1. Go to [github.com](https://github.com) and click **Sign up**
2. Create a free account
3. Verify your email

### Cloudflare
1. Go to [cloudflare.com](https://cloudflare.com) and click **Sign up**
2. Create a free account
3. Verify your email
4. When it asks you to add a website/domain — click **Skip** or **Add later** (you don't need one)

### API-Football
1. Go to [dashboard.api-football.com/register](https://dashboard.api-football.com/register)
2. Create a free account
3. After logging in, go to **My Account** or the dashboard home page
4. Copy the **API Key** shown there — save it somewhere (like Notepad), you'll need it later

---

## Step 2 — Copy this project to your GitHub

This is a public repository, and that's fine — none of your private keys or passwords are ever stored in the code. All sensitive values go into GitHub Secrets and Cloudflare Variables (covered in Steps 5 and 6), which are encrypted and never visible in the code files.

1. Go to this project's GitHub page
2. Click the green **Use this template** button at the top right
3. Click **Create a new repository**
4. Give your copy a name like `wc2026-bot`
5. Leave it set to **Public**
6. Click **Create repository**

You now have your own copy of the code on GitHub.

> **Don't see "Use this template"?** That button only appears on template repositories. If you see a **Fork** button instead, click that — then go to your forked repo's **Settings**, scroll to the bottom, and you can rename it there.

---

## Step 3 — Create a GroupMe Bot

A "bot" in GroupMe is just an automated poster attached to one group.

1. Go to [dev.groupme.com](https://dev.groupme.com) — log in with your GroupMe account
2. Click **Bots** in the top menu
3. Click **Create Bot**
4. Fill in:
   - **Bot Name**: anything you want, e.g. `WC2026 Updates`
   - **Group**: pick the GroupMe group where updates should be posted
   - **Callback URL**: leave this blank or type `https://example.com` — it doesn't matter
   - **Avatar URL**: optional, you can leave it blank
5. Click **Submit**
6. You'll now see your bot listed with a **Bot ID** — copy it and save it (like Notepad)

---

## Step 4 — Set up Cloudflare

### 4a — Create the database

The bot uses a database to store the match schedule and avoid posting the same event twice.

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) and log in
2. In the left sidebar, click **Workers & Pages**
3. Click **D1 SQL Database** in the sidebar (under Storage & Databases)
4. Click **Create database**
5. Name it exactly: `wc2026`
6. Click **Create**
7. After it's created, you'll see a page with your database. Look for **Database ID** — it's a long string of letters and numbers like `a1b2c3d4-...`
8. Copy it and save it

### 4b — Run the database setup script

The bot needs to create some tables inside the database.

1. On the same database page, click the **Console** tab
2. Copy and paste this entire block into the console and press **Execute**:

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

### 4c — Get your Cloudflare API Token

This lets GitHub deploy your bot to Cloudflare automatically.

1. Go to [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token**
3. Find the template called **Edit Cloudflare Workers** and click **Use template**
4. Scroll down and click **Continue to summary**
5. Click **Create Token**
6. Copy the token that appears — **this is the only time you'll see it**, so save it now

### 4d — Get your Cloudflare Account ID

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Click **Workers & Pages** in the left sidebar
3. Look at the right side of the page — you'll see **Account ID**
4. Copy it and save it

---

## Step 5 — Add all your secrets to GitHub

This is where you store all your sensitive information. GitHub keeps these encrypted and never shows them in the code.

1. Go to your GitHub repository (the one you created in Step 2)
2. Click **Settings** (top menu of the repo)
3. In the left sidebar, click **Secrets and variables** → **Actions**
4. Click **New repository secret** for each of the following:

| Secret Name | Where to get it | Example |
|-------------|----------------|---------|
| `CLOUDFLARE_API_TOKEN` | Step 4c | `abc123xyz...` |
| `CLOUDFLARE_ACCOUNT_ID` | Step 4d | `def456uvw...` |
| `D1_DATABASE_ID` | Step 4a | `a1b2c3d4-e5f6-...` |

To add each one:
- Click **New repository secret**
- Type the exact **Name** from the table above
- Paste the **Value**
- Click **Add secret**

Repeat until all 3 are added.

---

## Step 6 — Add your API keys to Cloudflare

The bot's API keys (for API-Football and GroupMe) are stored directly in Cloudflare, not in GitHub.

> ⚠️ Do this **after** the first deploy (Step 7), because the Worker needs to exist first.

After deploying once (Step 7), come back here:

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Click **Workers & Pages** in the left sidebar
3. Click on your worker named **wc2026-bot**
4. Click **Settings** → **Variables**
5. Under **Environment Variables**, click **Add variable** for each:

| Variable Name | Value |
|--------------|-------|
| `API_FOOTBALL_KEY` | Your API-Football key (from Step 1) |
| `GROUPME_BOT_ID` | Your GroupMe bot ID (from Step 3) |

6. For each variable, tick **Encrypt** so it's stored securely
7. Click **Save and deploy**

---

## Step 7 — Deploy the bot

Now you'll trigger the first deployment, which sends your code from GitHub to Cloudflare.

1. Go to your GitHub repository
2. Click the **Actions** tab (top menu)
3. You'll see a workflow called **Deploy to Cloudflare Workers**
4. Click on it, then click **Run workflow** → **Run workflow**
5. Wait about 1 minute — you'll see a green checkmark when it succeeds

The bot is now live on Cloudflare! Every time you make any change to the code on GitHub from now on, it will automatically redeploy within a minute.

---

## Step 8 — Initialize the bot (run once)

The very last step is telling the bot to fetch the group stage schedule and post it to GroupMe.

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Click **Workers & Pages** → **wc2026-bot**
3. Click the **Triggers** tab, then copy your worker's URL — it looks like:
   `https://wc2026-bot.YOUR-NAME.workers.dev`
4. Open a new browser tab and go to:
   `https://wc2026-bot.YOUR-NAME.workers.dev/?action=init`
5. You should see the message: `Group stage initialized and schedule posted.`
6. Check your GroupMe — the full group stage schedule should have just been posted!

**You're done.** The bot runs automatically from here. No computer needs to be on.

---

## How the bot works day to day

**During the group stage (June 11–26):**
- The bot monitors matches involving Spain, France, England, Argentina, Portugal, and USA
- It checks every minute if any tracked match is currently live
- If no match is active, it does nothing (uses zero API quota)
- When a match is live, it polls for new events and posts them

**From June 27 onward (knockout stage):**
- Every morning at 8AM UTC (4AM Eastern), the bot posts the next day's matches
- All knockout matches are tracked, regardless of which teams are playing

---

## Troubleshooting

**The bot isn't posting anything**
- Check that your `API_FOOTBALL_KEY` and `GROUPME_BOT_ID` variables are set correctly in Cloudflare (Step 6)
- Check the bot logs: Cloudflare Dashboard → Workers & Pages → wc2026-bot → **Logs**

**The deploy failed (red X in GitHub Actions)**
- Click on the failed run in the Actions tab to see the error message
- Most common cause: one of the 3 GitHub Secrets (Step 5) is missing or has a typo

**A country isn't being tracked**
- API-Football uses "United States" not "USA" — check the [Country Filter](#country-filter) section below

**I want to re-post the group stage schedule**
- Visit: `https://wc2026-bot.YOUR-NAME.workers.dev/?action=init`
- Note: this won't re-post if it already ran. To force it, go to Cloudflare D1 console and run:
  `DELETE FROM bot_state WHERE key = 'group_schedule_posted';`
  Then visit `?action=init` again.

---

## Manual triggers (for testing)

You can trigger bot actions manually by visiting these URLs in your browser:

| URL | What it does |
|-----|-------------|
| `?action=init` | Posts the group stage schedule (run once at setup) |
| `?action=daily` | Posts tomorrow's schedule right now |
| `?action=live` | Runs the live match poller right now |
| `?action=reset_fixture&id=FIXTURE_ID` | Resets a match so it re-posts events (for testing) |

Replace `FIXTURE_ID` with a number from the API-Football fixture list.

---

## Country Filter

The file `src/countries.js` controls which teams are tracked during the group stage.

**To follow ALL group stage matches:** delete the file `src/countries.js` from your GitHub repo (click the file → click the trash icon). The bot detects it's gone and tracks every match automatically.

**To change the list of countries:** click `src/countries.js` in your GitHub repo, click the pencil icon to edit, update the list, and click **Commit changes**. The bot redeploys automatically within a minute.

Team names must match exactly how API-Football spells them. When in doubt, use the full official name:
- ✅ `"United States"` — not `"USA"`
- ✅ `"South Korea"` — not `"Korea"`

---

## Project structure (for the curious)

```
wc2026-bot/
├── src/
│   ├── index.js       # Main brain — handles cron jobs and match logic
│   ├── api.js         # Talks to API-Football to get match data
│   ├── db.js          # Reads and writes to the Cloudflare database
│   ├── formatter.js   # Turns match data into readable GroupMe messages
│   ├── groupme.js     # Sends messages to GroupMe
│   └── countries.js   # Group stage country filter (delete to track all)
├── schema.sql          # Database table definitions (you ran this in Step 4b)
├── wrangler.toml       # Cloudflare Workers configuration
└── .github/
    └── workflows/
        └── deploy.yml  # Auto-deploy instructions for GitHub Actions
```

---

## License

MIT — free to use, modify, and share.
