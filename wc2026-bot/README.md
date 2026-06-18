# ⚽ FIFA World Cup 2026 — GroupMe Bot

A Cloudflare Workers bot that posts FIFA World Cup 2026 match updates to a GroupMe group.

**What it posts:**
- 📅 Full group stage schedule (once, on first run)
- 📅 Tomorrow's knockout matches (every day at 8AM UTC from June 27)
- 🚨 Kickoff alerts
- ⚽ Live goals (with assist), 🟨 cards, 🔄 substitutions, 📺 VAR decisions
- 🔔 Half-time scores
- 🏁 Full-time results + match stats (possession, shots, corners, fouls)

---

## Country Filter (Group Stage)

> ⚠️ **By default this bot only tracks these countries during the group stage:**
> **Spain, France, England, Argentina, Portugal, United States**
>
> All knockout stage matches are tracked regardless.
>
> **To follow ALL group stage teams:** delete the file `src/countries.js`.
> The bot detects its absence automatically and switches to tracking every match.
>
> **To change the list:** edit `src/countries.js` and update the `FOLLOWED_COUNTRIES` array.
> Team names must match API-Football exactly — use `"United States"` not `"USA"`.
> If a team isn't being picked up, verify its name via:
> `GET https://v3.football.api-sports.io/teams?league=1&season=2026`

---

## How It Works

### Architecture

- **Cloudflare Workers** — serverless, always-on, cron triggers
- **Cloudflare D1** — SQLite database storing fixture schedule and seen events
- **API-Football** — live match data source (free tier: 100 req/day)

### Smart Live Polling

The bot runs a cron every minute, but **makes zero API calls** when no matches are active. On each tick it queries D1 first:

> "Are there any fixtures that kicked off in the last 130 minutes and aren't finished yet?"

If the answer is no → exits immediately. If yes → hits the API for live data.
This keeps API usage minimal and well within the free tier on non-match days.

### Cron Schedule

| Cron | Action |
|------|--------|
| `* * * * *` | Smart live poller — checks D1 first, exits fast if no active games |
| `0 8 * * *` | Posts tomorrow's fixtures (knockout stage only) |

### Match Flow

```
Kickoff alert
  → Live events every ~1 min (goals, cards, subs, VAR)
    → Half-time score
      → More live events (2nd half)
        → Full-time result + stats
```

---

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free)
- [API-Football account](https://dashboard.api-football.com/register) (free tier)
- A GroupMe bot

---

### Step 1 — Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/wc2026-bot.git
cd wc2026-bot
npm install
```

---

### Step 2 — Create a GroupMe Bot

1. Go to [dev.groupme.com/bots](https://dev.groupme.com/bots)
2. Click **Create Bot**, pick your group, give it a name
3. Callback URL can be anything (e.g. `https://example.com`)
4. Save and copy your **Bot ID**

---

### Step 3 — Get an API-Football Key

1. Sign up at [api-football.com](https://www.api-football.com)
2. Copy your **API Key** from the dashboard
3. Verify the World Cup 2026 league ID by running:

```bash
curl -H "x-apisports-key: YOUR_KEY" \
  "https://v3.football.api-sports.io/leagues?name=FIFA+World+Cup&season=2026"
```

Check the `id` field in the response and update `WC_LEAGUE_ID` in `wrangler.toml` if it differs from `1`.

---

### Step 4 — Create a D1 Database

```bash
npx wrangler d1 create wc2026
```

Copy the `database_id` from the output and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "wc2026"
database_id = "PASTE_YOUR_ID_HERE"
```

Then run the schema:

```bash
npm run db:init
```

---

### Step 5 — Set Secrets

```bash
npx wrangler secret put API_FOOTBALL_KEY
# paste your API-Football key when prompted

npx wrangler secret put GROUPME_BOT_ID
# paste your GroupMe bot ID when prompted
```

---

### Step 6 — Local Development

```bash
cp .dev.vars.example .dev.vars
# fill in your keys in .dev.vars
npm run dev
```

The worker runs at `http://localhost:8787`.

**Manual triggers (useful for testing):**

| URL | What it does |
|-----|-------------|
| `?action=init` | Fetch + store group stage fixtures, post schedule to GroupMe |
| `?action=daily` | Run the daily job (post tomorrow's schedule) |
| `?action=live` | Run live polling once |
| `?action=reset_fixture&id=FIXTURE_ID` | Reset a fixture's state for retesting |

---

### Step 7 — Deploy

```bash
npm run deploy
```

---

### Step 8 — Initialize (run once after deploying)

Visit your deployed worker URL with `?action=init`:

```
https://wc2026-bot.YOUR_SUBDOMAIN.workers.dev/?action=init
```

This fetches the full group stage schedule (June 11–26), stores it in D1, and posts the schedule to your GroupMe group. **Only needs to be done once.**

From this point on everything is automatic.

---

## API Usage Estimate (Free Tier: 100 req/day)

| Call | When | Daily estimate |
|------|------|----------------|
| D1 active fixture check | Every minute | 0 API calls (D1 only) |
| Live fixtures | Only during match windows | ~15–30 req/match window |
| Events per live match | Every minute × active matches | ~15–60 req |
| Full-time stats | Per finished match | ~2–4 req |
| Daily schedule | Once/day | 1 req |

On group stage days with multiple tracked matches you may approach the limit.
Consider upgrading to the Basic plan (~$10/mo) for the group stage, or change the cron to `*/2 * * * *` (every 2 minutes) in `wrangler.toml` to halve usage.

---

## Auto-Deploy via GitHub Actions (No PC Needed)

Every push to the `main` branch automatically deploys to Cloudflare — no terminal required after initial setup. You can also trigger a deploy manually from the GitHub UI (Actions tab → Deploy to Cloudflare Workers → Run workflow).

### One-time GitHub setup

**1. Get your Cloudflare API token**

1. Go to [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token**
3. Use the **Edit Cloudflare Workers** template
4. Click **Continue to summary** → **Create Token**
5. Copy the token — you won't see it again

**2. Get your Cloudflare Account ID**

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Click on any domain (or Workers & Pages in the sidebar)
3. Your **Account ID** is shown in the right sidebar

**3. Add both as GitHub Secrets**

1. Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret** and add:

| Secret name | Value |
|-------------|-------|
| `CLOUDFLARE_API_TOKEN` | the token you created above |
| `CLOUDFLARE_ACCOUNT_ID` | your Cloudflare account ID |

That's it. From now on, every time you edit a file and commit to `main` on GitHub — even directly in the browser editor — the bot redeploys automatically within ~1 minute.

---

## Viewing Logs

```bash
npm run tail
```

---

## Project Structure

```
wc2026-bot/
├── src/
│   ├── index.js       # Main worker — cron dispatcher and all orchestration logic
│   ├── api.js         # API-Football wrapper
│   ├── db.js          # D1 database helpers
│   ├── formatter.js   # GroupMe message formatting
│   ├── groupme.js     # GroupMe posting (with auto message splitting)
│   └── countries.js   # ← GROUP STAGE FILTER — delete to follow all teams
├── schema.sql          # D1 table definitions
├── wrangler.toml       # Cloudflare Workers config
├── .dev.vars.example   # Local secrets template
└── package.json
```

---

## License

MIT
