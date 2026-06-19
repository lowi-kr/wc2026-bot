/**
 * groupme.js ā€” Post messages to GroupMe via bot
 */

const GROUPME_API = "https://api.groupme.com/v3/bots/post";
const MAX_LEN = 1000;

export async function postToGroupMe(env, text) {
  const safe   = sanitizeForSMS(text.trim());
  const chunks = splitMessage(safe, MAX_LEN);
  for (let i = 0; i < chunks.length; i++) {
    const res = await fetch(GROUPME_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_id: env.GROUPME_BOT_ID, text: chunks[i] }),
    });
    if (!res.ok) {
      console.error(`GroupMe post failed (chunk ${i + 1}): ${res.status}`);
    }
    if (i < chunks.length - 1) await sleep(600);
  }
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