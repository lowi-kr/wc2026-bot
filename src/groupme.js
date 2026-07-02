/**
 * groupme.js — Post messages to GroupMe via bot
 */

import { logEvent } from "./db.js";

const GROUPME_API = "https://api.groupme.com/v3/bots/post";
const MAX_LEN = 1000;

export async function postToGroupMe(env, text) {
  if (!env.GROUPME_BOT_ID) {
    // Fail loud — without this, JSON.stringify silently drops the bot_id key
    // entirely and GroupMe rejects the post, but the caller has no idea.
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
      // GroupMe can return a 2xx even for some invalid bot_id cases, so a
      // non-2xx here is a strong signal, but we log the body either way.
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
 * Convert accented Latin letters (common in player names, e.g. MbappĆ©, MĆ¼ller)
 * to plain ASCII equivalents, then strip any remaining non-ASCII characters
 * (emojis, symbols) that GroupMe's SMS fallback can't render.
 */
function sanitizeForSMS(text) {
  return text
    .normalize("NFKD")            // split accented chars into base + diacritic
    .replace(/[\u0300-\u036f]/g, "") // remove diacritic marks
    .replace(/[^\x00-\x7F]/g, "");   // strip anything still non-ASCII (emojis, etc.)
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
