// Failure modes: opt-in continuation duplicates or crosses threads, retains stale choices, loses pending answers,
// replays old approval against new content, skips delivery retries, or bypasses FYI expiry and ask permission.
import assert from "node:assert/strict";
import { test } from "node:test";
import { World, rules } from "../sim/world.ts";
import { rows } from "../kernel/evolve.ts";
import { Conflict } from "../kernel/errors.ts";
import { parseResult } from "../protocol/validate.ts";
import { checkSchema } from "../protocol/schema.ts";

const ask = {
  key: "pr",
  title: "待合并",
  text: "已检查",
  options: ["合并", "返工"],
  about: "只合并这一版",
  input: "返工意见",
  recommend: 0,
};
const fyi = { key: "pr", title: "上线中", text: "正在上线", fyi: true, continue: true };
function submit(w: World, receipt: object, subject = "#1", rule = "one") {
  w.call("ingest", "app", { id: `receipt-${w.view.seq}`, type: rule, subject });
  const job = w.call("claimNext", rule === "one" ? "w1" : "w2", `claim-${w.view.seq}`);
  assert.ok(job);
  const ack = w.finish(job.run, { outcome: "done", session: "session", ...receipt });
  return { job, ack };
}
const card = (w: World, id = 1) => w.view.get("cards", id)!;

test("continue is optional and strictly boolean in both receipt validators", () => {
  for (const kind of ["ask", "notice"])
    for (const value of [undefined, false, true, null, 0, 1, "true", [], {}]) {
      const spec = kind === "ask" ? ask : { title: "进度", text: "正在处理" };
      const result = { outcome: "done", [kind]: [{ ...spec, ...(value === undefined ? {} : { continue: value }) }] };
      const valid = value === undefined || typeof value === "boolean";
      assert.equal(checkSchema("result", result).length === 0, valid);
      if (valid) assert.doesNotThrow(() => parseResult(result));
      else assert.throws(() => parseResult(result));
    }
});

test("omitted and false retain closed-card behavior; continuation selects the latest card only within its thread", () => {
  const w = new World();
  try {
    for (const value of [undefined, false]) {
      submit(w, { ask: [{ ...ask, ...(value === undefined ? {} : { continue: value }) }] });
      w.call("resolve", rows(w.view, "cards").at(-1)!.id, "已结束", "owner");
    }
    assert.equal(rows(w.view, "cards").length, 2);
    submit(w, { notice: [fyi] });
    assert.deepEqual([card(w).kind, card(w, 2).kind, card(w, 2).state], ["ask", "notice", "closed"]);
    submit(w, { ask: [{ ...ask, continue: true }] }, "#2");
    assert.equal(rows(w.view, "cards").length, 3);
    assert.equal(card(w, 3).lane, "#2");
    assert.equal(card(w, 3).version, 1);
    submit(w, { ask: [{ ...ask, key: "suffix:pr", continue: true }] }, "#2");
    submit(w, { notice: [fyi] }, "#2:suffix");
    assert.equal(rows(w.view, "cards").length, 5, "delimiters in keys cannot cross thread boundaries");
    assert.equal(card(w, 4).kind, "ask");
  } finally {
    w.view.close();
  }
});

test("an answered card reopens with one content increment and immutable pending answers across repeated continuations", () => {
  const w = new World();
  try {
    submit(w, { ask: [ask] });
    const original = card(w);
    w.call("ingest", "app", { id: "in-flight", type: "one", subject: "#1" });
    const running = w.call("claimNext", "w1", "in-flight");
    w.call("answer", 1, { choice: 0, version: 1, by: "owner" });
    const facts = JSON.stringify(w.log);
    const decidedVersion = card(w).version;
    w.finish(running.run, {
      outcome: "done",
      ask: [{ ...ask, title: "重新决定", options: ["上线", "暂缓"], continue: true }],
    });
    assert.equal(JSON.stringify(w.log.slice(0, JSON.parse(facts).length)), facts);
    assert.deepEqual(
      [card(w).state, card(w).version, card(w).content_version, card(w).choice, card(w).answer_event],
      ["open", decidedVersion + 1, decidedVersion + 1, null, null],
    );
    for (const key of [
      "id",
      "created_at",
      "rule",
      "lane",
      "grp",
      "source",
      "agent",
      "session",
      "workspace_run",
      "run_id",
    ])
      assert.equal(card(w)[key], original[key], key);
    assert.throws(() => w.call("answer", 1, { choice: 0, version: 1 }), Conflict);
    w.call("answer", 1, { text: "再核实", version: card(w).version });
    w.restart();
    const next = w.call("claimNext", "w1", "answers");
    assert.equal(next.session, "session");
    assert.deepEqual(
      next.context.answers.map((a: any) => [a.card, a.title, a.choice === null ? a.text : a.options[a.choice]]),
      [
        [1, "待合并", "合并"],
        [1, "重新决定", "再核实"],
      ],
    );
    const beforeFinish = card(w).version;
    w.finish(next.run, { outcome: "done", notice: [fyi] });
    assert.equal(
      card(w).version,
      beforeFinish + 1,
      "continuation replaces automatic answer settlement in the same receipt",
    );
    const history = submit(w, {}).job;
    assert.deepEqual(history.context.answers, []);
    assert.deepEqual(
      history.context.decided.map((a: any) => [a.title, a.choice]).sort(),
      [
        ["待合并", "合并"],
        ["重新决定", "再核实"],
      ].sort(),
    );
    assert.equal(rows(w.view, "events", { type: "card.answered" }).length, 2);
  } finally {
    w.view.close();
  }
});

test("ask to FYI to ask replaces full content, resets deliveries at original refs, and skips identical content", () => {
  const w = new World();
  try {
    submit(w, { ask: [{ ...ask, continue: true }] });
    w.deliverAll();
    const original = card(w);
    submit(w, { notice: [fyi] });
    assert.deepEqual(
      [card(w).kind, card(w).state, card(w).fyi, card(w).options, card(w).recommend, card(w).about, card(w).input],
      ["notice", "closed", 1, "[]", null, "", null],
    );
    for (const channel of ["chat", "plain"]) {
      const update = w.call("nextCard", channel);
      assert.deepEqual([update.id, update.ref, update.version, update.options], [1, `${channel}-1`, 2, []]);
      w.call("failed", channel, 1, 2, "断线");
    }
    w.advance(58 * 60_000);
    for (const channel of ["chat", "plain"]) assert.equal(w.call("nextCard", channel), null);
    submit(w, { ask: [{ ...ask, continue: true }] });
    for (const channel of ["chat", "plain"]) {
      const delivery = w.view.get("deliveries", `1:${channel}`)!;
      assert.deepEqual(
        [delivery.ref, delivery.tries, delivery.first_try_at, delivery.not_before, delivery.given_up, delivery.error],
        [`${channel}-1`, 0, null, null, 0, null],
      );
      const update = w.call("nextCard", channel);
      assert.deepEqual(
        [update.state, update.version, update.content_version, update.input, update.fyi],
        ["open", 3, 3, "返工意见", false],
      );
      w.call("delivered", channel, 1, 3, update.ref);
    }
    submit(w, { ask: [{ ...ask, continue: true }] });
    assert.equal(card(w).version, 3);
    assert.equal(card(w).created_at, original.created_at);
    assert.equal(w.call("nextCard", "chat"), null);
    assert.equal(w.log.at(-1)!.meta!.cards[0].action, "duplicate");
    assert.equal(rows(w.view, "cards").length, 1);
  } finally {
    w.view.close();
  }
});

test("unchanged words still reopen decided and done cards, invalidate the prior answer and retain history", () => {
  const w = new World();
  try {
    submit(w, { ask: [ask] });
    w.call("answer", 1, { choice: 0, version: 1 });
    const decided = card(w).version;
    submit(w, { ask: [{ ...ask, continue: true }] });
    assert.deepEqual([card(w).state, card(w).version, card(w).content_version], ["open", decided + 1, decided + 1]);
    assert.throws(() => w.call("answer", 1, { choice: 0, version: 1 }), Conflict);
    w.call("answer", 1, { choice: 1, version: card(w).version });
    submit(w, {});
    assert.equal(card(w).state, "done");
    const done = card(w).version;
    submit(w, { ask: [{ ...ask, continue: true, recommend: undefined, about: undefined, input: undefined }] });
    assert.deepEqual(
      [card(w).state, card(w).version, card(w).recommend, card(w).about, card(w).input],
      ["open", done + 1, null, "", null],
    );
    submit(w, { notice: [{ ...fyi, fyi: false }] });
    assert.deepEqual([card(w).kind, card(w).state, card(w).fyi], ["notice", "open", 0]);
    assert.deepEqual(w.call("nextCard", "chat").options, ["已处理"]);
    submit(w, { notice: [fyi] });
    w.deliverAll();
    const version = card(w).version;
    submit(w, { notice: [fyi] });
    assert.equal(card(w).version, version);
    assert.equal(w.call("nextCard", "chat"), null);
  } finally {
    w.view.close();
  }
});

test("FYI first-send expiry, resolve ordering, once notifications and ask permission stay in force", () => {
  const w = new World();
  try {
    submit(w, { notice: [fyi] });
    w.call("delivered", "chat", 1, 1, "original");
    w.advance(25 * 60 * 60_000);
    submit(w, { notice: [{ ...fyi, text: "已上线" }] });
    assert.equal(w.call("nextCard", "plain"), null);
    assert.equal(w.call("nextCard", "chat").ref, "original");
    submit(w, { ask: [{ ...ask, continue: true }] });
    assert.equal(w.call("nextCard", "plain").id, 1, "open cards have no first-send expiry");
    const before = card(w).version;
    submit(w, { resolve: [{ card: 1, reason: "旧问题结束" }], ask: [{ ...ask, continue: true }] });
    assert.deepEqual([card(w).state, card(w).version, card(w).result], ["open", before + 2, null]);
    const config = structuredClone(rules);
    config.rules[0].ask = false;
    w.call("rules", config);
    const saved = card(w);
    assert.equal(submit(w, { ask: [{ ...ask, text: "绕过限制", continue: true }] }).ack.rejected[0].what, "ask");
    assert.deepEqual(card(w), saved);
    const once = w.call("tell", "source:app:once", "告知", "原文");
    w.call("tell", "source:app:once", "新标题", "新内容");
    assert.equal(card(w, once.card).version, 1);
    assert.equal(card(w, once.card).text, "原文");
  } finally {
    w.view.close();
  }
});
