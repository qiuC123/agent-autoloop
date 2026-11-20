// Failure modes: polling fills the fact log; replay loses the latest presence or lease, revives expired deadlines,
// or reopens a resolved offline notice. Legacy heartbeat facts must still establish the original online status.
import assert from "node:assert/strict";
import { test } from "node:test";
import { snapshot } from "../kernel/evolve.ts";
import { rebuild } from "../kernel/store.ts";
import { at, setup } from "./helpers.ts";

setup("heartbeat-retention");
const hub = await import("../host/runtime.ts");

test("legacy presence, worker and channel polling, and active leases survive replay without a fact per poll", () => {
  const initial = hub.getView();
  const seen = { kind: "worker", name: "w2", seen_at: new Date(at(0)).toISOString() };
  const legacy = {
    version: 1,
    seq: initial.seq + 1,
    at: at(0),
    type: "heartbeat",
    changes: [{ table: "seen", key: "worker:w2", row: seen }],
  };
  hub.db.prepare("INSERT INTO facts VALUES (?,?)").run(legacy.seq, JSON.stringify(legacy));
  rebuild(hub.db, initial.format);
  assert.deepEqual(hub.getView().get("seen", "worker:w2"), seen);
  const status = (worker: string, now: number) => hub.stateOf(now).agents.find((agent) => agent.worker === worker)!;
  assert.equal(status("w2", at(2)).online, true);
  assert.equal(status("w2", at(2) + 1).online, false);

  hub.ingest("app", { id: "one", type: "feedback.new" }, at(1));
  const job = hub.claimNext("w1", "claim", at(1))!;
  const before = hub.getView().seq;
  for (let minute = 2; minute <= 15; minute++) {
    hub.heartbeat("w1", [job.run], at(minute));
    hub.execute("channelSeen", ["chat"], at(minute));
  }
  assert.equal(hub.getView().seq, before);
  assert.equal(hub.getView().get("runs", job.run)!.seen_at, new Date(at(15)).toISOString());
  assert.equal(status("w1", at(17)).online, true);
  assert.equal(status("w1", at(17) + 1).online, false);
  assert.equal(hub.stateOf(at(17)).channels.find((channel) => channel.id === "chat")!.online, true);
  const expected = snapshot(hub.getView());
  assert.deepEqual(snapshot(rebuild(hub.db, initial.format)), expected);
  assert.deepEqual(hub.logAfter(legacy.seq - 1, 1)[0], legacy);

  hub.finish(job.run, job.token, { outcome: "done" }, at(16));
  assert.equal(hub.getView().seq, before + 1);
  const done = snapshot(hub.getView());
  assert.deepEqual(snapshot(rebuild(hub.db, initial.format)), done);
  assert.equal(hub.getView().get("runs", job.run)!.state, "done");
});

test("reconnection keeps the card closure as a durable business fact", () => {
  hub.heartbeat("w1", [], at(20));
  hub.ingest("app", { id: "offline", type: "feedback.new" }, at(30));
  hub.sweep(at(31));
  const card = hub.all<{ id: number }>("SELECT id FROM cards WHERE state='open' AND key LIKE 'worker:w1:offline:%'")[0];
  assert.ok(card);
  const seq = hub.getView().seq;
  const old = snapshot(hub.getView());
  hub.db.exec("CREATE TEMP TRIGGER reject_close BEFORE INSERT ON facts BEGIN SELECT RAISE(ABORT,'busy'); END");
  assert.throws(() => hub.heartbeat("w1", [], at(32)), /busy/);
  hub.db.exec("DROP TRIGGER reject_close");
  assert.deepEqual(snapshot(hub.getView()), old);
  hub.heartbeat("w1", [], at(32));
  const [fact] = hub.logAfter(seq);
  assert.deepEqual(
    fact.changes.map((change) => change.table),
    ["cards"],
  );
  assert.equal(hub.getView().get("cards", card.id)!.state, "closed");
  const view = hub.getView();
  const expected = snapshot(view);
  assert.deepEqual(snapshot(rebuild(hub.db, view.format)), expected);
});
