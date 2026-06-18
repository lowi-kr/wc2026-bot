const GROUPME_API = "https://api.groupme.com/v3/bots/post";

/**
 * Post a message to GroupMe via bot.
 * Splits long messages automatically (GroupMe limit: 1000 chars).
 */
export async function postToGroupMe(env, text) {
  const chunks = splitMessage(text, 1000);
  for (const chunk of chunks) {
    const res = await fetch(GROUPME_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bot_id: env.GROUPME_BOT_ID,
        text: chunk,
      }),
    });
    if (!res.ok) {
      console.error(`GroupMe post failed: ${res.status} ${res.statusText}`);
    }
    // Small delay between chunks to avoid rate limiting
    if (chunks.length > 1) await sleep(500);
  }
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    // Try to split at a newline
    let idx = remaining.lastIndexOf("\n", maxLen);
    if (idx === -1) idx = maxLen;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
