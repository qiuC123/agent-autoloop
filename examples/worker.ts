// A short synchronous worker; long jobs need worker/'s heartbeat, cancellation and recovery.
import { randomUUID } from "node:crypto";
const { AGENT_AUTOLOOP_URL: url, AGENT_AUTOLOOP_KEY: key } = process.env;
if (!url || !key) throw new Error("设置 AGENT_AUTOLOOP_URL 和 AGENT_AUTOLOOP_KEY");
async function request(route: string, token = key!, body?: unknown) {
  const response = await fetch(url + route, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(65000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
let claim = process.env.AGENT_AUTOLOOP_CLAIM ?? randomUUID();
do {
  const { job } = await request(`/v1/work?claim=${encodeURIComponent(claim)}&wait=50`);
  if (job) {
    await request(`/v1/runs/${job.run}/started`, job.token, {});
    const receipt = JSON.parse(process.env.AGENT_AUTOLOOP_RECEIPT ?? '{"outcome":"done","summary":"处理完成"}');
    console.log(JSON.stringify(await request(`/v1/runs/${job.run}/result`, job.token, receipt)));
    claim = randomUUID();
  }
} while (process.env.AGENT_AUTOLOOP_ONCE !== "1");
