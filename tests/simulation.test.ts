// Failure modes: faults lose accepted events, duplicate execution or answers, exceed parallel limits, change receipts,
// diverge from replay, or strand work after recovery; an enumerator silently skips one ordering; mutation checks do not run.
// FYIs must never acquire pending work, buttons or answer events, including after replay.
import assert from "node:assert/strict";
import { test } from "node:test";
import { simulate } from "../sim/random.ts";
import { enumerate, enumerateCards } from "../sim/enumerate.ts";
import { World } from "../sim/world.ts";
import { AuthError } from "../kernel/errors.ts";
import { empty, evolve } from "../kernel/evolve.ts";
import { invariants } from "../sim/invariants.ts";

test("200000 deterministic fault steps preserve safety and recovered work terminates", () => {
  const result = simulate(0x5eed, 200000);
  assert.equal(result.steps, 200000);
  for (const fault of [
    "lost",
    "duplicate",
    "restart",
    "offline",
    "channel",
    "clock",
    "update",
    "staleAnswer",
    "fyi",
    "continue",
    "reopen",
    "changeKind",
  ])
    assert.ok(result.faults[fault] > 0, fault);
  assert.ok(result.completed > 0);
  console.log(JSON.stringify(result));
});

test("all card update, stale answer, settlement, delivery and restart orderings preserve safety", () => {
  const result = enumerateCards();
  assert.equal(result.paths, 5040);
  assert.equal(result.actions, 7);
  console.log(JSON.stringify(result));
});

test("card invariants catch stale accepted answers, lost delivery and replay divergence", () => {
  const world = new World();
  const spec = { key: "q", kind: "ask", title: "选", text: "原文", options: ["甲", "乙"] };
  try {
    world.call("createCard", spec);
    world.call("createCard", { ...spec, text: "新文" }, true);
    const original = world.call;
    world.call = function (type, ...args) {
      return type === "nextCard" ? null : original.call(this, type, ...args);
    };
    assert.throws(() => world.deliverAll(), /没有追上/);
    world.call = original;
    world.deliverAll();
    const before = world.checked;
    world.call("answer", 1, { choice: 0, version: 2 });
    assert.throws(
      () => invariants(world.view, world.log, before, { type: "answer", args: [1, { choice: 0, version: 1 }] }),
      /旧内容/,
    );
    const changed = structuredClone(world.log);
    changed.at(-1)!.changes.find((c) => c.table === "cards")!.row!.content_version = 1;
    assert.throws(() => invariants(world.view, changed), /日志重放/);
  } finally {
    world.view.close();
  }
});

test("FYI invariants reject a replayable log that turns information into pending work", () => {
  const world = new World();
  try {
    world.call("createCard", { key: "progress", kind: "notice", title: "进度", text: "已交出", fyi: true });
    world.restart();
    const log = structuredClone(world.log);
    log.at(-1)!.changes.find((change) => change.table === "cards")!.row!.state = "open";
    const corrupted = evolve(empty(), log);
    try {
      assert.throws(() => invariants(corrupted, log), /只告知的卡片不能变成待办/);
    } finally {
      corrupted.close();
    }
  } finally {
    world.view.close();
  }
});

test("bounded exhaustive schedules use two workers, two events and one card", () => {
  const result = enumerate();
  assert.equal(result.paths, 40320);
  assert.equal(result.actions, 8);
  assert.ok(result.transitions >= 40320 * 8);
  console.log(JSON.stringify(result));
});

test("the simulator rejects a hub that refuses valid receipt replays", () => {
  const original = World.prototype.call;
  World.prototype.call = function (type: string, ...args: any[]) {
    const run = this.view.get("runs", args[0])!;
    if (type === "finish" && run?.last_issued && run.issued === null) throw new AuthError("故意拒绝有效重放");
    return original.call(this, type, ...args);
  };
  try {
    assert.throws(() => simulate(24301, 2048), /种子/);
  } finally {
    World.prototype.call = original;
  }
});

test("answer checks reject a run in the wrong subject lane", () => {
  const w = new World();
  w.call("createCard", {
    key: "q",
    kind: "ask",
    title: "选",
    options: ["甲", "乙"],
    rule: "one",
    lane: "#1",
    grp: "shared",
    source: "app",
  });
  w.call("answer", 1, { choice: 0 });
  const log = structuredClone(w.log);
  for (const f of log) for (const c of f.changes) if (c.table === "runs" && c.row) c.row.lane = "wrong-lane";
  assert.throws(() => invariants(evolve(new World().view, log.slice(1)), log), /原事项/);
});

test("the simulation catches omitted deadlines that strand deferred work", () => {
  const original = World.prototype.act;
  World.prototype.act = function (input) {
    const value = original.call(this, input);
    this.log = this.log.map((f) => ({ ...f, changes: f.changes.filter((c) => c.table !== "due") }));
    this.view.close();
    this.view = evolve(empty(), this.log);
    return value;
  };
  try {
    assert.throws(() => simulate(24301, 2048));
  } finally {
    World.prototype.act = original;
  }
});
