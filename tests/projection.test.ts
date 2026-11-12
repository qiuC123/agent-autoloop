// Failure modes: a draft mutates its base; filtered reads miss changed/new rows or retain deleted rows;
// restart replays all history, reuses a deleted ID, or trusts an incompatible projection;
// opening a second process briefly drops views used by the running service;
// history size forces a point lookup to scan or populate a whole JavaScript table.
// Old cards must acquire creation content_version, not their latest state version, on rebuild without rewriting facts.
// Historical notices and FYI reports must keep their original lifecycle and delivery flag.
// Rebuilding answer snapshots must preserve the original question after its card changes, without rewriting old facts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { empty, evolve, rows, snapshot, type Fact } from "../kernel/evolve.ts";
import { commit, openView } from "../kernel/store.ts";
import { cardView } from "../kernel/query.ts";

const fact = (seq: number, changes: Fact["changes"]): Fact => ({ version: 1, seq, at: seq, type: "fixture", changes });

test("old answer facts rebuild immutable snapshots across a continuation and format change", () => {
  const db = new DatabaseSync(":memory:");
  const old = {
    id: 1,
    answer_event: 7,
    state: "decided",
    rule: "one",
    lane: "#1",
    title: "旧问题",
    options: '["同意","取消"]',
    choice: 0,
  };
  let view = commit(db, openView(db, "old"), () => [fact(1, [{ table: "cards", key: "1", row: old }])]);
  view = commit(db, view, () => [
    fact(2, [
      { table: "cards", key: "1", row: { ...old, state: "open", answer_event: null, choice: null, title: "新问题" } },
    ]),
  ]);
  const saved = db.prepare("SELECT * FROM facts ORDER BY seq").all();
  const answer = { ...old, id: 7, card_id: 1 };
  assert.deepEqual(view.get("answers", 7), answer);
  assert.deepEqual(openView(db, "new").get("answers", 7), answer);
  assert.deepEqual(db.prepare("SELECT * FROM facts ORDER BY seq").all(), saved);
  db.close();
});
test("legacy notices and reports survive restart and projection rebuild without reinterpretation", () => {
  const db = new DatabaseSync(":memory:");
  const cards = [
    { id: 1, kind: "notice", state: "open", fyi: 0 },
    { id: 2, kind: "notice", state: "closed", fyi: 0 },
    { id: 3, kind: "notice", state: "closed", fyi: 1 },
  ];
  commit(db, openView(db, "old-format"), () => [
    fact(
      1,
      cards.map((row) => ({ table: "cards", key: String(row.id), row })),
    ),
  ]);
  const saved = db.prepare("SELECT fact FROM facts").get()!.fact;
  for (const format of ["old-format", "new-format"]) {
    const view = openView(db, format);
    for (const old of cards) {
      const card = view.get("cards", old.id)!;
      assert.deepEqual(card, { content_version: 1, input: null, ...old });
      const shown = cardView(card, { secret: "test", publicUrl: "https://hub.test" });
      assert.deepEqual(shown.options, old.state === "open" ? ["已处理"] : []);
      assert.equal(shown.fyi, Boolean(old.fyi));
    }
  }
  assert.equal(db.prepare("SELECT fact FROM facts").get()!.fact, saved);
  db.close();
});
test("old logs rebuild cards with content_version 1 without changing their historical state or facts", () => {
  const db = new DatabaseSync(":memory:");
  const view = openView(db, "old-format");
  const old = { id: 1, version: 4, kind: "ask", state: "done", title: "旧卡片", options: '["甲","乙"]' };
  const log = fact(1, [{ table: "cards", key: "1", row: old }]);
  commit(db, view, () => [log]);
  const saved = db.prepare("SELECT fact FROM facts").get()!.fact;
  const rebuilt = openView(db, "new-format");
  assert.deepEqual(rebuilt.get("cards", 1), { content_version: 1, input: null, ...old });
  assert.equal(db.prepare("SELECT fact FROM facts").get()!.fact, saved);
  assert.deepEqual(snapshot(openView(db, "new-format")), snapshot(rebuilt));
  db.close();
});
test("a draft overlays filtered reads without changing the base", () => {
  const base = evolve(empty(), [
    fact(1, [
      { table: "cards", key: "1", row: { id: 1, state: "open" } },
      { table: "cards", key: "2", row: { id: 2, state: "closed" } },
    ]),
  ]);
  const before = snapshot(base);
  const draft = base.fork();
  draft.set("cards", "1", { id: 1, state: "closed" });
  draft.set("cards", "2", { id: 2, state: "open" });
  draft.set("cards", "3", { id: 3, state: "open" });
  assert.deepEqual(
    rows(draft, "cards", { state: "open" }).map((r) => r.id),
    [2, 3],
  );
  draft.set("cards", "2", null);
  assert.deepEqual(
    rows(draft, "cards", { state: "open" }).map((r) => r.id),
    [3],
  );
  assert.deepEqual(snapshot(base), before);
  base.close();
});

test("restart reuses projections and preserves deleted ID high water", () => {
  const db = new DatabaseSync(":memory:");
  let view = openView(db, "format-a");
  view = commit(db, view, () => [fact(1, [{ table: "timers", key: "9", row: { id: 9 } }])]);
  view = commit(db, view, () => [
    fact(2, [
      { table: "timers", key: "9", row: null },
      { table: "events", key: "1", row: { id: 1 } },
    ]),
  ]);
  db.exec(
    "CREATE TEMP TRIGGER no_reset BEFORE DELETE ON projections BEGIN SELECT RAISE(ABORT,'unexpected replay'); END",
  );
  const reopened = openView(db, "format-a");
  assert.equal(reopened.seq, 2);
  assert.equal(reopened.next.timers, 9);
  assert.deepEqual(snapshot(reopened), snapshot(view));
  db.exec("DROP TRIGGER no_reset");
  const expected = snapshot(reopened);
  assert.deepEqual(snapshot(openView(db, "format-b")), expected);
  db.close();
});

test("opening another process never exposes a missing SQL view", async () => {
  const { setup } = await import("./helpers.ts");
  const { join } = await import("node:path");
  const home = setup("projection-open");
  const other = new DatabaseSync(join(home, "hub.db"));
  other.exec(
    "CREATE TABLE projections(collection TEXT,key TEXT,data TEXT,PRIMARY KEY(collection,key)); CREATE VIEW cards AS SELECT data FROM projections WHERE collection='cards'",
  );
  other.function("card_token", (_id, _at) => "");
  const exec = DatabaseSync.prototype.exec;
  let checked = false;
  DatabaseSync.prototype.exec = function (sql) {
    exec.call(this, sql);
    if (sql.includes("DROP VIEW IF EXISTS cards")) {
      checked = true;
      assert.equal(other.prepare("SELECT COUNT(*) AS n FROM cards").get()!.n, 0);
    }
  };
  try {
    const hub = await import("../host/runtime.ts");
    hub.db.close();
    assert.ok(checked);
  } finally {
    DatabaseSync.prototype.exec = exec;
    other.close();
  }
});
