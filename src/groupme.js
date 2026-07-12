/**
 * groupme.js — Post messages to GroupMe via bot
 */

import { logEvent } from "./db.js";

const GROUPME_API = "https://api.groupme.com/v3/bots/post";
const MAX_LEN = 1000;
const MUTE_KV_KEY = "muted_until";

export async function postToGroupMe(env, text, opts = {}) {
  const { bypassMute = false } = opts;

  if (!bypassMute) {
    const mutedUntilRaw = await env.KV.get(MUTE_KV_KEY);
    const mutedUntil = mutedUntilRaw ? parseInt(mutedUntilRaw, 10) : 0;
    if (mutedUntil && Date.now() < mutedUntil) {
      await logEvent(env.DB, "debug", `Muted — suppressed automated post until ${new Date(mutedUntil).toISOString()}`);
      return true;
    }
  }

  if (!env.GROUPME_BOT_ID) {
    console.error("GROUPME_BOT_ID is not set — cannot post to GroupMe.");
    await logEvent(env.DB, "error", "GROUPME_BOT_ID secret is missing — message NOT sent to GroupMe.");
    return false;
  }

  const safe   = sanitizeForSMS(text.trim());
  const chunks = splitMessage(safe, MAX_LEN);
  let allOk = true;

  for (let i = 0; i < chunks.length; i++) {
    let res, bodyText;
    try {
      res = await fetch(GROUPME_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bot_id: env.GROUPME_BOT_ID, text: chunks[i] }),
      });
      bodyText = await res.text().catch(() => "");
    } catch (err) {
      allOk = false;
      console.error(`GroupMe post threw (chunk ${i + 1}):`, err);
      await logEvent(env.DB, "error", `GroupMe post network error (chunk ${i + 1}/${chunks.length}): ${err.message}`);
      continue;
    }
    if (!res.ok) {
      allOk = false;
      console.error(`GroupMe post failed (chunk ${i + 1}): ${res.status} ${bodyText}`);
      await logEvent(
        env.DB,
        "error",
        `GroupMe post failed (chunk ${i + 1}/${chunks.length}): HTTP ${res.status} — ${bodyText.slice(0, 300)}`
      );
    }
    if (i < chunks.length - 1) await sleep(600);
  }
  return allOk;
}

/**
 * Convert accented Latin letters (common in player names, e.g. Mbappe, Muller)
 * to plain ASCII equivalents, then strip any remaining non-ASCII characters
 * (emojis, symbols) that GroupMe's SMS fallback can't render.
 */
function sanitizeForSMS(text) {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "");
}

function splitMessage(text, max) {
  if (text.length <= max) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > max) {
    let idx = remaining.lastIndexOf("\n", max);
    if (idx <= 0) idx = max;
    chunks.push(remaining.slice(0, idx).trimEnd());
    remaining = remaining.slice(idx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
