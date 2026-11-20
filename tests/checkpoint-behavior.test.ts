// Failure modes: a missing prefix causes a receipt or event to execute twice, a card loses its original
// message or thread, or a saved timer wakes twice after rebuilding without the offline archive.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrate } from "../scripts/checkpoint.ts";
import { at, setup } from "./helpers.ts";

const event = { id: "case-1", type: "feedback.new", subject: "case-1" };
const receipt = {
  outcome: "done",
  ask: [{ key: "decision", title: "继续处理？", text: "请选择", options: ["是", "否"] }],
  later: [{ key: "follow-up", at: new Date(at(4)).toISOString(), about: "核对办理结果" }],
};
const ref = "message-21";

if (process.argv[2] === "restored") {
  const { run, token, eventId, cardId, version, timerId, head } = JSON.parse(readFileSync(0, "utf8"));
  const hub = await import("../host/runtime.ts");
  try {
    assert.deepEqual(hub.ingest("app", event, at(2)), { event: eventId, duplicate: true, routed: ["意见"] });
    assert.deepEqual(hub.finish(run, token, receipt, at(2)), { duplicate: true, rejected: [] });
    const answer = { version, choice: 1, channel: "chat", ref, by: "me" };
    assert.throws(() => hub.answer(cardId, { ...answer, ref: "another-message" }, at(2)), /消息/);
    assert.throws(() => hub.answer(cardId, { ...answer, by: "another-user" }, at(2)), /不能回答/);
    assert.equal(hub.getView().seq, head);
    assert.equal(hub.answer(cardId, answer, at(2)).changed, true);
    assert.equal(hub.answer(cardId, answer, at(2)).changed, false);
    const update = hub.nextCard("chat", at(2))!;
    assert.deepEqual([update.id, update.ref, update.state], [cardId, ref, "decided"]);
    const resumed = hub.claimNext("w1", "resumed", at(2))!;
    assert.equal(resumed.run, run + 1);
    assert.deepEqual([resumed.rule.name, resumed.session], ["意见", "case-session"]);
    assert.deepEqual(
      resumed.context.events.map((e) => [e.type, e.subject]),
      [["card.answered", event.subject]],
    );
    assert.deepEqual(
      resumed.context.answers.map((a) => [a.card, a.choice, a.by]),
      [[cardId, 1, "me"]],
    );
    hub.finish(resumed.run, resumed.token, { outcome: "nothing" }, at(2));
    hub.tick(at(3));
    assert.equal(hub.claimNext("w1", "early", at(3)), null);
    hub.tick(at(4));
    hub.tick(at(4));
    const due = hub.claimNext("w1", "due", at(4))!;
    assert.deepEqual([due.run, due.rule.name, due.session], [run + 2, "意见", "case-session"]);
    assert.deepEqual(
      due.context.events.map((e) => [e.id, e.type, e.subject]),
      [[`timer:${timerId}`, "timer.due", event.subject]],
    );
    assert.deepEqual(due.context.timers, receipt.later);
    hub.finish(due.run, due.token, { outcome: "nothing" }, at(4));
    hub.tick(at(4));
    assert.equal(hub.claimNext("w1", "again", at(4)), null);
  } finally {
    hub.db.close();
  }
} else {
  const home = setup("checkpoint-behavior");
  test("a restarted work database preserves receipts, channel answers and timers with the archive offline", async () => {
    const hub = await import("../host/runtime.ts");
    const accepted = hub.ingest("app", event, at(0));
    const job = hub.claimNext("w1", "initial", at(0))!;
    hub.started(job.run, job.token, { session: "case-session" }, at(0));
    assert.deepEqual(hub.finish(job.run, job.token, receipt, at(1)).rejected, []);
    const card = hub.nextCard("chat", at(1))!;
    hub.delivered("chat", card.id, card.version, ref, at(1));
    const timer = hub.one<{ id: number }>("SELECT id FROM timers WHERE key=?", ["follow-up"])!;
    hub.ingest("app", { id: "tail", type: "unmatched" }, at(1));
    const head = hub.getView().seq;
    hub.db.close();

    const dest = join(home, "migration");
    const migrated = await migrate(join(home, "hub.db"), join(home, "master.key"), dest, 1);
    assert.deepEqual([migrated.checkpoint, migrated.tail], [head - 1, 1]);
    renameSync(join(dest, "archive"), join(home, "offline"));
    const work = join(dest, "work");
    for (const name of ["master.key", "maintenance.json"]) copyFileSync(join(home, name), join(work, name));
    // Lose the expendable view cursor so normal runtime startup must actually replay the retained tail.
    const db = new DatabaseSync(join(work, "hub.db"));
    try {
      db.exec("DELETE FROM projection_meta");
    } finally {
      db.close();
    }
    const child = spawnSync(process.execPath, [import.meta.filename, "restored"], {
      env: { ...process.env, AGENT_AUTOLOOP_HOME: work },
      input: JSON.stringify({
        run: job.run,
        token: job.token,
        eventId: accepted.event,
        cardId: card.id,
        version: card.version,
        timerId: timer.id,
        head,
      }),
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
  });
}
