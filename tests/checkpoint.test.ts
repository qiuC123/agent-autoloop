// A sealed prefix must never disappear on rebuild, reuse an ID, or mask a damaged/mismatched base or tail.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { checkpointPath, fileDigest, loadCheckpoint, projectionFormat } from "../host/checkpoint.ts";
import { replayCheck } from "../scripts/replay-check.ts";
import { snapshot, type Fact } from "../kernel/evolve.ts";
import { commit, openView, rebuild } from "../kernel/store.ts";

const fact = (seq: number, changes: Fact["changes"]): Fact => ({ version: 1, seq, at: seq, type: "test", changes });
const tail = fact(3, [{ table: "cards", key: "1", row: { id: 1, version: 2 } }]);

function fixture(t: TestContext, format = "candidate") {
  const dir = mkdtempSync(join(tmpdir(), "history-test-"));
  const file = join(dir, "hub.db");
  const db = new DatabaseSync(file);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let view = commit(db, openView(db, format), () => [
    fact(1, [
      { table: "cards", key: "1", row: { id: 1, version: 1 } },
      { table: "timers", key: "6", row: { id: 6 } },
      { table: "runs", key: "4", row: { id: 4 } },
      { table: "deliveries", key: "1:inbox", row: { card_id: 1, channel: "inbox", ref: "message", version: 1 } },
    ]),
  ]);
  view = commit(db, view, () => [fact(2, [{ table: "timers", key: "6", row: null }])]);
  const base = join(dir, "base.db");
  db.prepare("VACUUM INTO ?").run(base);
  const cp = new DatabaseSync(base);
  cp.exec(
    "DELETE FROM facts; DELETE FROM projection_refs; CREATE TABLE checkpoint_info(id,version,fact_version,identity,seq); INSERT INTO checkpoint_info VALUES (1,1,1,'test',2)",
  );
  cp.close();
  const sha = fileDigest(base);
  const path = checkpointPath(file, sha);
  renameSync(base, path);
  const archive = () => {
    db.prepare("INSERT INTO history_checkpoint VALUES (1,'test',2,4,?,?)").run(sha, format);
    db.exec("DELETE FROM facts WHERE seq<=2; DELETE FROM projection_refs WHERE seq<=2");
  };
  return { db, file, view, path, archive };
}

test("candidate opens a private checkpoint copy and actually replays its bounded tail without writing the source", (t) => {
  const { db, file, view, archive } = fixture(t, projectionFormat("test"));
  commit(db, view, () => [tail]);
  archive();
  const before = fileDigest(file);
  const { checkpoint_seq, seq, count } = replayCheck(file, "test");
  assert.deepEqual([checkpoint_seq, seq, count], [2, 3, 1]);
  assert.equal(fileDigest(file), before);
  assert.throws(() => replayCheck(file, "wrong"), /指纹/);
  db.prepare("UPDATE facts SET fact=? WHERE seq=3").run(JSON.stringify({ ...tail, version: 9 }));
  assert.throws(() => replayCheck(file, "test"), /版本/);
  db.prepare("INSERT INTO facts VALUES (4,?)").run(" ".repeat(4 * 1024 * 1024));
  assert.throws(() => replayCheck(file, "test"), /预算/);
});

test("a checkpoint with an empty tail accepts the next seq and matches complete independent replay, including pending and deleted IDs", (t) => {
  const { db, view, archive } = fixture(t);
  commit(db, view, () => [tail]);
  const expected = snapshot(rebuild(db, "candidate"));
  const pending = db.prepare("SELECT * FROM projection_pending").all();
  archive();
  db.exec("DELETE FROM facts WHERE seq=3; DELETE FROM projection_meta");
  loadCheckpoint(db, "candidate");
  assert.throws(() => db.exec("DELETE FROM sealed.projections"), /readonly/);
  const restored = openView(db, "candidate");
  assert.equal(restored.seq, 2);
  assert.equal(restored.next.timers, 6);
  assert.deepEqual(snapshot(commit(db, restored, () => [tail])), expected);
  assert.deepEqual(snapshot(rebuild(db, "candidate")), expected);
  assert.deepEqual(db.prepare("SELECT * FROM projection_pending").all(), pending);
  assert.deepEqual(
    db
      .prepare("SELECT DISTINCT seq FROM projection_refs")
      .all()
      .map((r) => r.seq),
    [3],
  );
});

test("a missing, damaged or incompatible checkpoint blocks even when the working projection is intact", (t) => {
  const { db, path, archive } = fixture(t);
  archive();
  assert.throws(() => loadCheckpoint(db, "different"), /指纹/);
  renameSync(path, path + ".moved");
  assert.throws(() => loadCheckpoint(db, "candidate"));
  writeFileSync(path, "damaged");
  assert.throws(() => loadCheckpoint(db, "candidate"), /摘要/);
});

test("replay rejects a gap, a wrong embedded seq and a future fact version, and rolls the reset back", (t) => {
  const { db, archive } = fixture(t);
  archive();
  loadCheckpoint(db, "candidate");
  for (const [key, data] of [
    [4, tail],
    [3, { ...tail, seq: 4 }],
    [3, { ...tail, version: 2 }],
  ] as const) {
    db.prepare("INSERT INTO facts VALUES (?,?)").run(key, JSON.stringify(data));
    assert.throws(() => rebuild(db, "candidate"));
    assert.equal(db.prepare("SELECT seq FROM projection_meta").get()!.seq, 2);
    db.exec("DELETE FROM facts");
  }
});

test("killing the sealing process immediately before or after COMMIT exposes one complete boundary", (t) => {
  const { db, file, path } = fixture(t);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  const module = new URL("../scripts/checkpoint.ts", import.meta.url).href;
  const record = JSON.stringify({ identity: "test", seq: 2, run: 4, sha256: fileDigest(path), format: "candidate" });
  for (const edge of ["before", "after"]) {
    const child = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        `
      import { DatabaseSync } from "node:sqlite";
      import { installSeal } from ${JSON.stringify(module)};
      const db = new DatabaseSync(process.argv[1]);
      const exec = db.exec.bind(db);
      db.exec = sql => {
        if (sql !== "COMMIT") return exec(sql);
        if (process.argv[2] === "after") exec(sql);
        process.kill(process.pid,"SIGKILL");
      };
      installSeal(db,undefined,JSON.parse(process.argv[3]));
    `,
        file,
        edge,
        record,
      ],
      { encoding: "utf8" },
    );
    assert.ok(child.signal === "SIGKILL" || (process.platform === "win32" && child.status === 1), child.stderr);
    assert.equal(child.stderr, "");
    assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
    const sealed = edge === "after";
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM facts").get()!.n, sealed ? 0 : 2);
    assert.equal(!!db.prepare("SELECT * FROM history_checkpoint").get(), sealed);
    assert.equal(!!db.prepare("SELECT * FROM projection_refs LIMIT 1").get(), !sealed);
    loadCheckpoint(db, "candidate");
    assert.equal(rebuild(db, "candidate").seq, 2);
  }
});
