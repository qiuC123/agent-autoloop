// Failure modes: maintenance races a claim or a waking long poll; recovery loses an existing claim or receipt;
// unstarted or unknown runs are mistaken for drained work; restart, expiry, missing files or corrupt files reopen
// the gate; stale IDs or non-owner credentials release it; rejected rules look accepted; timers/cards stop progressing.
// Owner settlement must release unknown work without accepting late receipts or giving workers owner powers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import { after, beforeEach, test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("maintenance");
const rulesFile = join(home, "rules.json");
const fixture = readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8");
writeFileSync(rulesFile, fixture);
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
const hub = await import("../host/runtime.ts");
const { makeHandler } = await import("../host/server.ts");
const runtime = makeHandler();
after(runtime.close);
const keys = {
  owner: hub.addKey("owner", "owner"),
  w1: hub.addKey("worker", "w1"),
  w2: hub.addKey("worker", "w2"),
  app: hub.addKey("source", "app"),
  chat: hub.addKey("channel", "chat"),
};
const file = join(home, "maintenance.json");
const bootRecord = JSON.parse(readFileSync(file, "utf8"));
const normal = { mode: "normal", id: null, entered_at: null, deadline: null };
const future = () => new Date(Date.now() + 3600_000).toISOString();
async function call(path: string, key = keys.owner, body?: unknown, signal?: AbortSignal) {
  const response = await runtime.handle(
    new Request(`http://hub.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    }),
  );
  return { status: response.status, body: (await response.json()) as any };
}
const control = (action: string, extra: Record<string, unknown> = {}) =>
  call("/v1/maintenance", keys.owner, { action, ...extra });
const drain = () => control("drain", { deadline: future() });
const work = (key: string, claim: string, extra = "") => call(`/v1/work?wait=0&claim=${claim}${extra}`, key);
const event = (id: string) => hub.ingest("app", { id, type: "feedback.new", subject: id });
const finish = (job: any, body: unknown = { outcome: "done" }) => call(`/v1/runs/${job.run}/result`, job.token, body);
function restart() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const code = `const hub = await import('./host/runtime.ts');
    console.log(JSON.stringify({status:hub.execute('maintenance',[${JSON.stringify(keys.owner)}]),
      job:hub.claimNext('w1','after-restart')})); hub.db.close();`;
  const child = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code],
    {
      cwd: join(import.meta.dirname, ".."),
      env,
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
beforeEach(() => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers", "due"] as const)
    hub.fixtureClear(table);
  writeFileSync(file, JSON.stringify(normal));
});

test("only the owner controls maintenance; normal workers retain the old response", async () => {
  assert.deepEqual(bootRecord, normal, "first adoption initializes normal mode for existing clients");
  for (const key of ["", "wrong", keys.w1, keys.app, keys.chat]) {
    assert.equal((await call("/v1/maintenance", key)).status, 401);
    assert.equal((await call("/v1/maintenance", key, { action: "drain", deadline: future() })).status, 401);
  }
  const status = await call("/v1/maintenance");
  assert.equal(status.status, 200);
  assert.equal(status.body.mode, "normal");
  assert.equal(status.body.claimed, 0);
  assert.equal(status.body.unknown, 0);
  assert.ok(Number.isSafeInteger(status.body.rules_version));
  assert.match(status.body.rules_hash, /^[a-f0-9]{64}$/);
  event("legacy");
  const old = await work(keys.w1, "legacy");
  assert.equal(old.status, 200);
  assert.deepEqual(Object.keys(old.body).sort(), ["cancel", "job"]);
  assert.ok(old.body.job);
  assert.equal((await call("/v1/maintenance", old.body.job.token)).status, 401);
});

test("drain and competing workers serialize; an unstarted claim blocks hold and survives lost responses", async () => {
  event("first");
  const [entered, first, second] = await Promise.all([drain(), work(keys.w1, "race"), work(keys.w1, "race-other")]);
  assert.equal(entered.status, 200);
  const id = entered.body.id;
  for (const result of [first, second])
    if (result.body.job) {
      assert.equal((await control("hold", { id })).status, 409, "claimed before started still counts");
      const claim = result === first ? "race" : "race-other";
      const again = (await work(keys.w1, claim)).body.job;
      assert.equal(again.run, result.body.job.run);
      assert.deepEqual({ ...again, token: result.body.job.token }, result.body.job);
      assert.equal((await finish(again)).status, 200);
      assert.equal((await finish(again)).body.duplicate, true);
    }
  event("queued");
  hub.ingest("ops", { id: "other-worker", type: "alert.raised" });
  const waiting = await Promise.all([work(keys.w1, "new-1"), work(keys.w2, "new-2")]);
  assert.deepEqual(
    waiting.map((r) => r.body.job),
    [null, null],
  );
  assert.equal((await control("hold", { id })).body.mode, "held");
  assert.equal((await work(keys.w1, "held")).body.job, null);
});

test("offline claim recovery, heartbeat, started, cancellation and late receipt replay remain usable", async () => {
  event("offline");
  const job = (await work(keys.w1, "lost-response")).body.job;
  assert.ok(job);
  const { id } = (await drain()).body;
  assert.equal((await control("hold", { id })).status, 409);
  const now = Date.now();
  hub.sweep(now + 11 * 60_000);
  const recovered = (await work(keys.w1, "lost-response", `&running=${job.run}`)).body.job;
  assert.equal(recovered.run, job.run);
  assert.equal((await call(`/v1/runs/${job.run}/started`, recovered.token, { session: "resumed" })).status, 200);
  await call(`/v1/runs/${job.run}/cancel`, keys.owner, {});
  const pulse = await work(keys.w1, "no-new-work", `&capacity=0&running=${job.run}`);
  assert.deepEqual(pulse.body, { job: null, cancel: [job.run] });
  assert.equal((await finish(recovered, { outcome: "cancelled" })).status, 200);
  assert.equal((await control("hold", { id })).body.mode, "held");
  assert.equal((await finish(recovered, { outcome: "cancelled" })).body.duplicate, true);
});

test("unknown runs block hold until a late result arrives", async () => {
  event("unknown");
  const job = (await work(keys.w1, "unknown")).body.job;
  const { id } = (await drain()).body;
  const later = Date.now() + 6 * 60_000;
  hub.heartbeat("w1", [], later);
  hub.sweep(later);
  const status = (await call("/v1/maintenance")).body;
  assert.deepEqual([status.claimed, status.unknown], [0, 1]);
  assert.equal((await control("hold", { id })).status, 409);
  assert.equal((await finish(job)).status, 200);
  assert.equal((await control("hold", { id })).body.mode, "held");
});

for (const action of ["cancel", "answer"]) {
  test(`the owner can settle unknown work through ${action} and then hold maintenance`, async () => {
    event(`settle-${action}`);
    const job = (await work(keys.w1, `settle-${action}`)).body.job;
    const { id } = (await drain()).body;
    const later = Date.now() + 6 * 60_000;
    hub.heartbeat("w1", [], later);
    hub.sweep(later);
    const card = hub.one<any>("SELECT * FROM cards WHERE key = ?", [`run:${job.run}:unknown`]);
    assert.ok(card);
    assert.equal((await call("/v1/state")).body.totals.unknown, 1);
    assert.equal((await control("hold", { id })).status, 409);
    const endpoint = action === "cancel" ? `/v1/runs/${job.run}/cancel` : `/v1/cards/${card.id}/answer`;
    for (const key of ["", keys.w1, keys.app, keys.chat, job.token])
      assert.equal((await call(endpoint, key, {})).status, 401);
    assert.equal((await call(endpoint, keys.owner, {})).status, 200);
    const settled = { ...hub.getView().get("runs", job.run)! };
    assert.equal(settled.state, "cancelled");
    assert.ok(settled.finished_at);
    assert.equal(settled.summary, "本人确认按未完成结束");
    assert.match(card.text, /已处理.*按未完成结束/);
    const closed = { ...hub.getView().get("cards", card.id)! };
    assert.equal(closed.state, "closed");
    assert.equal(closed.result, settled.summary);
    assert.equal((await call("/v1/state")).body.totals.unknown, 0);
    assert.equal((await control("hold", { id })).body.mode, "held");
    assert.deepEqual((await call(`/v1/cards/${card.id}/answer`, keys.owner, {})).body, {
      changed: false,
      state: "closed",
    });
    const seq = hub.getView().seq;
    for (const outcome of ["done", "failed", "cancelled"]) {
      const late = {
        outcome,
        notice: [{ title: "late", text: "must not apply" }],
        events: [{ id: "late", type: "feedback.new" }],
        later: [{ key: "late", at: future(), about: "late" }],
      };
      assert.equal((await finish(job, late)).status, 401);
      assert.equal((await finish(job, late)).status, 401);
    }
    assert.deepEqual(hub.getView().get("runs", job.run), settled);
    assert.deepEqual(hub.getView().get("cards", card.id), closed);
    assert.equal(hub.getView().seq, seq, "rejected late receipts cannot write facts or dispatch downstream work");
  });
}

test("a long poll rechecks the gate after wakeup and resume wakes queued work", async () => {
  const abort = new AbortController();
  let settled = false;
  const pending = call("/v1/work?wait=5&claim=long", keys.w1, undefined, abort.signal).then((value) => {
    settled = true;
    return value;
  });
  try {
    await setImmediate();
    const { id } = (await drain()).body;
    event("wake-while-draining");
    await setTimeout(30);
    assert.equal(settled, false);
    assert.equal((await call("/v1/maintenance")).body.claimed, 0);
    assert.equal((await control("hold", { id })).status, 200);
    await control("resume", { id });
    assert.ok((await pending).body.job);
  } finally {
    abort.abort();
    await pending;
  }
});

test("events, answers, cron, later and cards progress while held without claiming work", async () => {
  event("question");
  const job = (await work(keys.w1, "question")).body.job;
  assert.equal(
    (
      await finish(job, {
        outcome: "done",
        ask: [{ title: "继续？", text: "请选择", options: ["是", "否"], key: "question" }],
        later: [{ key: "later", at: new Date(Date.now() + 60_000).toISOString(), about: "复查" }],
      })
    ).status,
    200,
  );
  const { id } = (await drain()).body;
  assert.equal((await control("hold", { id })).body.mode, "held");
  const card = (await call("/v1/cards/next?wait=0", keys.chat)).body.card;
  assert.ok(card);
  assert.equal((await call(`/v1/cards/${card.id}/answer`, keys.owner, { choice: 0 })).status, 200);
  assert.equal((await call("/v1/events", keys.app, { id: "during-held", type: "feedback.new" })).status, 200);
  hub.tick(Date.now() + 6 * 60_000);
  const types = hub.all<{ type: string }>("SELECT type FROM events").map((row) => row.type);
  assert.ok(types.includes("card.answered"));
  assert.ok(types.includes("timer.due"));
  assert.ok(types.includes("schedule.tick"));
  assert.equal((await work(keys.w1, "blocked")).body.job, null);
});

test("held survives a real new process; expiry and stale IDs never release a later maintenance", async () => {
  const first = (await drain()).body;
  assert.equal((await drain()).body.id, first.id, "enter is idempotent");
  await control("hold", { id: first.id });
  assert.equal((await control("hold", { id: first.id })).body.mode, "held");
  event("restart");
  const before = hub.getView().seq;
  const boot = restart();
  assert.equal(boot.status.mode, "held");
  assert.equal(boot.status.id, first.id);
  assert.equal(boot.job, null);
  assert.equal(hub.getView().seq, before, "maintenance adds no facts");
  const expired = { ...JSON.parse(readFileSync(file, "utf8")), deadline: first.entered_at };
  writeFileSync(file, JSON.stringify(expired));
  assert.equal((await call("/v1/maintenance")).body.expired, true);
  assert.equal((await control("resume", { id: first.id })).status, 409);
  assert.equal((await work(keys.w1, "expired")).body.job, null);
  const deadline = future();
  assert.equal((await control("renew", { id: "wrong", deadline })).status, 409);
  assert.equal((await control("renew", { id: first.id, deadline })).status, 200);
  assert.equal((await control("renew", { id: first.id, deadline })).status, 200);
  assert.equal((await control("resume", { id: "wrong" })).status, 409);
  assert.equal((await control("resume", { id: first.id })).body.mode, "normal");
  assert.equal((await control("resume", { id: first.id })).body.mode, "normal");
  const second = (await drain()).body;
  assert.notEqual(second.id, first.id);
  assert.equal((await control("resume", { id: first.id })).status, 409);
  assert.equal((await work(keys.w1, "stale")).body.job, null);
});

test("missing, unreadable and invalid maintenance files fail closed across restart; owner can start recovery", async () => {
  event("corruption");
  for (const content of [
    null,
    "{",
    "{}",
    JSON.stringify({ ...normal, mode: "bogus" }),
    JSON.stringify({ mode: "normal", id: "wrong", entered_at: "bad", deadline: "bad" }),
  ]) {
    if (content === null) rmSync(file);
    else writeFileSync(file, content);
    const status = (await call("/v1/maintenance")).body;
    assert.equal(status.mode, "draining");
    assert.ok(status.problem);
    assert.equal((await work(keys.w1, "broken")).body.job, null);
    const boot = restart();
    assert.ok(boot.status.problem);
    assert.equal(boot.job, null);
    assert.equal((await control("resume", { id: "wrong" })).status, 409);
    const recovery = (await drain()).body;
    assert.ok(recovery.id);
    assert.equal(recovery.problem, null);
  }
  rmSync(file);
  mkdirSync(file);
  try {
    assert.ok((await call("/v1/maintenance")).body.problem);
    assert.equal((await work(keys.w1, "unreadable")).body.job, null);
    assert.equal(restart().job, null);
  } finally {
    rmSync(file, { recursive: true });
  }
  assert.equal((await drain()).body.mode, "draining");
});

test("status identifies accepted rules even when a bad file keeps the previous configuration", async () => {
  const previous = (await call("/v1/maintenance")).body;
  try {
    writeFileSync(rulesFile, "{broken");
    assert.ok(hub.reloadRules().problem);
    const rejected = (await call("/v1/maintenance")).body;
    assert.equal(rejected.rules_version, previous.rules_version);
    assert.equal(rejected.rules_hash, previous.rules_hash);
    const updated = JSON.parse(fixture);
    updated.rules[0].prompt = "新的规则";
    writeFileSync(rulesFile, JSON.stringify(updated));
    assert.equal(hub.reloadRules().changed, true);
    const accepted = (await call("/v1/maintenance")).body;
    assert.ok(accepted.rules_version > previous.rules_version);
    assert.notEqual(accepted.rules_hash, previous.rules_hash);
  } finally {
    writeFileSync(rulesFile, fixture);
    hub.reloadRules();
  }
});

test("malformed transitions do not alter the gate and authorization is rechecked after reading the body", async () => {
  for (const input of [
    null,
    [],
    {},
    { action: "resume" },
    { action: "drain", deadline: "bad" },
    { action: "drain", deadline: new Date(0).toISOString() },
    { action: "drain", deadline: future(), extra: true },
  ]) {
    assert.equal((await call("/v1/maintenance", keys.owner, input)).status, 400);
    assert.equal((await call("/v1/maintenance")).body.mode, "normal");
  }
  const key = hub.addKey("owner", "revoked");
  let send!: (bytes: Uint8Array) => void;
  let close!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      send = (b) => c.enqueue(b);
      close = () => c.close();
    },
  });
  const pending = runtime.handle(
    new Request("http://hub.test/v1/maintenance", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body,
      duplex: "half",
    } as RequestInit),
  );
  hub.removeKey("owner", "revoked");
  send(new TextEncoder().encode(JSON.stringify({ action: "drain", deadline: future() })));
  close();
  assert.equal((await pending).status, 401);
});
