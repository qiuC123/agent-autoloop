// Failure modes: a draft mutates its base; filtered reads miss changed/new rows or retain deleted rows;
// restart replays all history, reuses a deleted ID, or trusts an incompatible projection;
// opening a second process briefly drops views used by the running service;
// history size forces a point lookup to scan or populate a whole JavaScript table.
// Old cards must acquire creation content_version, not their latest state version, on rebuild without rewriting facts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { empty, evolve, rows, snapshot, type Fact } from "../kernel/evolve.ts";
import { commit, openView } from "../kernel/store.ts";

const fact = (seq: number, changes: Fact["changes"]): Fact => ({ version: 1, seq, at: seq, type: "fixture", changes });
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
