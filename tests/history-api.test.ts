// Failure modes: an archived cursor silently skips facts, an old run shows a partial explanation, or
// trimming recent runs also hides active work. A slow subscriber must stop before it sends facts across a gap.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { hubClient } from "../protocol/client.ts";
import { checkSchema } from "../protocol/schema.ts";
import { setup } from "./helpers.ts";

const home = setup("history-api");
const hub = await import("../host/runtime.ts");
const { makeHandler } = await import("../host/server.ts");
const { serve } = await import("../host/http.ts");
const runtime = makeHandler();
after(runtime.close);
const owner = hub.addKey("owner", "owner");
const source = hub.addKey("source", "app");
const call = (path: string, key = owner, headers = {}) =>
  runtime.handle(new Request(`http://local${path}`, { headers: { authorization: `Bearer ${key}`, ...headers } }));

test("archived history is explicit and current work remains visible on the first page", async () => {
  const slow = (await call("/v1/stream?after=0")).body!.getReader();
  hub.ingest("app", { id: "finished", type: "feedback.new", subject: "finished" });
  const finished = hub.claimNext("w1", "finished")!;
  hub.finish(finished.run, finished.token, { outcome: "done" });
  hub.ingest("app", { id: "active", type: "feedback.new", subject: "active" });
  const active = hub.claimNext("w1", "active")!;
  const { seq, next, format } = hub.getView();
  const run = next.runs!;
  assert.ok(run < seq);
  hub.db
    .prepare("INSERT INTO history_checkpoint(id,identity,seq,run,sha256,format) VALUES (1,?,?,?,?,?)")
    .run("test", seq, run, "test", format);
  hub.db.prepare("DELETE FROM facts WHERE seq<=?").run(seq);
  hub.db.prepare("DELETE FROM projection_refs WHERE seq<=?").run(seq);
  hub.ingest("app", { id: "fresh", type: "feedback.new", subject: "fresh" });
  const fresh = hub.claimNext("w1", "fresh")!;

  for (const response of [
    await call(`/v1/stream?after=${seq - 1}`),
    await call("/v1/stream", owner, { "Last-Event-ID": "0" }),
    await call(`/v1/state?before=${run}`),
    await call(`/v1/runs/${active.run}/why`),
  ]) {
    assert.equal(response.status, 410);
    const error = await response.json();
    assert.deepEqual(error, { error: "history_archived", checkpoint_seq: seq });
    assert.deepEqual(checkSchema("error", error), []);
  }
  for (const path of ["/v1/stream?after=0", `/v1/state?before=${run}`, `/v1/runs/${active.run}/why`])
    assert.equal((await call(path, source)).status, 401);
  assert.equal((await call("/v1/runs/999999/why")).status, 404);
  const decoder = new TextDecoder();
  const buffered = await slow.read();
  if (!buffered.done) {
    assert.match(decoder.decode(buffered.value), /^id: 1\n/);
    assert.equal((await slow.read()).done, true);
  }
  for (const [path, headers, first] of [
    ["/v1/stream", {}, seq + 1],
    ["/v1/stream", { "Last-Event-ID": String(seq) }, seq + 1],
    [`/v1/stream?after=${seq + 1}`, {}, seq + 2],
  ] as const) {
    const response = await call(path, owner, headers);
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.ok(decoder.decode((await reader.read()).value).startsWith(`id: ${first}\n`));
    await reader.cancel();
  }
  const state = await (await call("/v1/state")).json();
  assert.equal(state.checkpoint_seq, seq);
  assert.ok(state.runs.some((job: { id: number }) => job.id === active.run));
  assert.ok(!state.runs.some((job: { id: number }) => job.id === finished.run));
  assert.ok(state.totals.done >= 1);
  assert.equal(state.hasMore, false);
  assert.deepEqual((await (await call(`/v1/state?before=${fresh.run}`)).json()).runs, []);

  const response = await call(`/v1/runs/${fresh.run}/why`);
  assert.equal(response.headers.get("X-Checkpoint-Seq"), String(seq));
  const facts = await response.json();
  assert.ok(facts.length >= 2 && facts.every((f: { seq: number }) => f.seq > seq));

  const server = serve(0);
  try {
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const client = hubClient(url, owner);
    assert.deepEqual(await client.why(fresh.run), facts);
    await assert.rejects(client.why(active.run), new RegExp(`已归档.*${seq}`));
    writeFileSync(join(home, "config.json"), JSON.stringify({ url, owner }));
    const cli = (...args: string[]) => promisify(execFile)(process.execPath, ["bin/agent-autoloop.ts", ...args]);
    const timeline = (await cli("why", String(fresh.run))).stdout;
    assert.match(timeline, new RegExp(`#${seq}.*已归档`));
    assert.match(timeline, /领取/);
    const mcp = cli("mcp");
    mcp.child.stdin!.end(
      [
        { id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: {} } },
        { method: "notifications/initialized" },
        { id: 2, method: "tools/call", params: { name: "why", arguments: { run: fresh.run } } },
      ]
        .map((request) => JSON.stringify({ jsonrpc: "2.0", ...request }))
        .join("\n") + "\n",
    );
    const result = JSON.parse((await mcp).stdout.trim().split("\n").at(-1)!);
    assert.deepEqual(JSON.parse(result.result.content[0].text), { checkpoint_seq: seq, facts });
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
