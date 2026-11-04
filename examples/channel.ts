// stdout is the destination; a chat integration replaces the print with its own send.
const { AGENT_AUTOLOOP_URL: url, AGENT_AUTOLOOP_KEY: key } = process.env;
if (!url || !key) throw new Error("设置 AGENT_AUTOLOOP_URL 和 AGENT_AUTOLOOP_KEY");
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
do {
  const response = await fetch(`${url}/v1/cards/next?wait=50`, { headers, signal: AbortSignal.timeout(65000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { card } = await response.json();
  if (card) {
    console.log(JSON.stringify(card));
    const sent = await fetch(`${url}/v1/cards/${card.id}/delivered`, {
      method: "POST",
      headers,
      body: JSON.stringify({ version: card.version, ref: card.ref ?? `curl-${card.id}` }),
    });
    if (!sent.ok) throw new Error(`HTTP ${sent.status}`);
  }
} while (process.env.AGENT_AUTOLOOP_ONCE !== "1");
