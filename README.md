# ⚽ FIFA World Cup 2026 — GroupMe Bot

A Cloudflare Workers bot that posts FIFA World Cup 2026 match updates to GroupMe — live goals, substitutions, cards, half-time scores, full-time summaries with stats, and daily schedules.

---

## Features

- 📅 **Group stage schedule** — posted once automatically on first run
- 📅 **Daily schedule** — posts tomorrow's fixtures every day at 8AM UTC starting June 27
- 🚨 **Kickoff alerts** — fires when a match starts
- ⚽ **Live events** — goals (with assist), yellow/red cards, substitutions, VAR decisions
- 🔔 **Half-time score**
- 🏁 **Full-time summary** — result + possession, shots, corners stats
- 🔁 **Polling every 1 minute** during live matches
- 💾 **Cloudflare KV** — deduplicates events, tracks match state

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free)
- [API-Football account](https://dashboard.api-football.com/register) (free tier)
- A GroupMe bot (see below)

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/wc2026-bot.git
cd wc2026-bot
npm install
```

### 2. Create a GroupMe Bot

1. Go to [dev.groupme.com/bots](https://dev.groupme.com/bots)
2. Click **Create Bot**
3. Select your group, give it a name (e.g. "WC2026 Bot")
4. Set callback URL to anything for now (Workers don't need it for posting)
5. Copy your **Bot ID**

### 3. Get an API-Football Key

1. Sign up at [api-football.com](https://www.api-football.com)
2. Go to your dashboard and copy your **API Key**
3. The free tier gives you **100 requests/day** — sufficient for this bot with KV caching

> **Verify the World Cup 2026 league ID:**
> After signing up, hit `https://v3.football.api-sports.io/leagues?name=FIFA+World+Cup&season=2026`
> with your key in the header `x-apisports-key`. Confirm the `id` field and update `WC_LEAGUE_ID` in `wrangler.toml` if needed.

### 4. Create a KV Namespace

```bash
npx wrangler kv:namespace create "KV"
npx wrangler kv:namespace create "KV" --preview
```

Copy the `id` and `preview_id` values into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KV"
id = "PASTE_ID_HERE"
preview_id = "PASTE_PREVIEW_ID_HERE"
```

### 5. Set Secrets

```bash
npx wrangler secret put API_FOOTBALL_KEY
# paste your API-Football key when prompted

npx wrangler secret put GROUPME_BOT_ID
# paste your GroupMe bot ID when prompted
```

### 6. Local Development

Copy the example vars file:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and fill in your keys. Then run:

```bash
npm run dev
```

The worker runs at `http://localhost:8787`. You can manually trigger actions:

| URL | Action |
|-----|--------|
| `http://localhost:8787/?action=group` | Post full group stage schedule |
| `http://localhost:8787/?action=schedule` | Post tomorrow's schedule |
| `http://localhost:8787/?action=live` | Run live polling now |
| `http://localhost:8787/?action=reset&id=FIXTURE_ID` | Reset a fixture's state |

### 7. Deploy

```bash
npm run deploy
```

That's it — Cloudflare handles the cron triggers automatically.

---

## How It Works

### Cron Schedule

| Cron | What it does |
|------|-------------|
| `* * * * *` | Polls for live matches every minute |
| `0 8 * * *` | Posts tomorrow's fixtures at 8AM UTC |

### First Run Behavior

On the very first `0 8 * * *` trigger (or manual `?action=group`), the bot fetches and posts the **entire group stage schedule** (June 11–26) as a one-time post. This only happens once — a KV flag prevents re-posting.

### Live Polling Flow

```
Every minute:
  → Fetch live WC2026 fixtures
  → For each live fixture:
      → If just kicked off → post kickoff alert
      → If half time → post HT score
      → If full time → post FT summary + stats
      → Otherwise → fetch events, filter already-seen ones, post new ones
```

### API Usage Estimate (Free Tier: 100 req/day)

| Call | Frequency | Daily est. |
|------|-----------|------------|
| Live fixtures | Every 1 min | ~90 req |
| Events per live match | Every 1 min × matches | ~30–90 req |
| Stats at FT | Per match | ~4 req |
| Schedule | Once/day | ~1 req |

> ⚠️ On match-heavy days (group stage has up to 8 games/day), you may hit the 100 req/day limit. Consider upgrading to the Basic plan (~$10/mo) during the group stage, or increase polling interval to every 2 minutes by changing the cron in `wrangler.toml`.

---

## Configuration

All config lives in `wrangler.toml` `[vars]` and can be overridden with secrets:

| Variable | Default | Description |
|----------|---------|-------------|
| `WC_LEAGUE_ID` | `1` | API-Football league ID for WC 2026 |
| `WC_SEASON` | `2026` | Season year |
| `GROUP_STAGE_END` | `2026-06-26` | Last day of group stage |
| `DAILY_SCHEDULE_START` | `2026-06-27` | When daily "tomorrow" posts begin |

---

## Viewing Logs

```bash
npm run tail
```

---

## License

MIT
