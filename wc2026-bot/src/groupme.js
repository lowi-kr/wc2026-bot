/**
 * groupme.js — Post messages to GroupMe via bot
 */

const GROUPME_API = "https://api.groupme.com/v3/bots/post";
const MAX_LEN = 1000;

export async function postToGroupMe(env, text) {
  const chunks = splitMessage(text.trim(), MAX_LEN);
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
