// Failure modes: sealing drops an ID, answer snapshot, pending delivery or late fact; a stale backup discards new writes;
// a damaged or foreign archive is accepted when rebuilding a checkpoint under a different engine fingerprint.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { commit, openView } from "../kernel/store.ts";
import type { Fact } from "../kernel/evolve.ts";
import { finalize, migrate, rollback } from "../scripts/checkpoint.ts";
import { checkpointPath, fileDigest, registerCardFunctions } from "../host/checkpoint.ts";

test("migration, independent replay, offline archive and guarded rollback on the same copy", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "autoloop-retention-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "original.db"),
    key = join(dir, "master.key"),
    dest = join(dir, "migration");
  writeFileSync(key, "fixture-key");
  const db = new DatabaseSync(source);
  const fact = (seq: number, changes: Fact["changes"]): Fact => ({
    version: 1,
    at: seq,
    seq,
    changes,
    type: "fixture",
  });
  let view = openView(db, "previous-release");
  for (const f of [
    fact(1, [{ table: "runs", key: "9", row: { id: 9 } }]),
    fact(2, [
      { table: "runs", key: "9", row: null },
      { table: "cards", key: "1", row: { id: 1, version: 2, answer_event: 8 } },
    ]),
    fact(3, [{ table: "deliveries", key: "1:chat", row: { card_id: 1, channel: "chat", ref: "ref", version: 1 } }]),
    fact(4, [{ table: "events", key: "1", row: { id: 1 } }]),
  ])
    view = commit(db, view, () => [f]);
  const result = await migrate(source, key, dest, 1);
  assert.equal(result.checkpoint, 3);
  assert.equal(result.head, 4);
  const work = join(dest, "work", "hub.db");
  const inspect = new DatabaseSync(work, { readOnly: true });
  assert.deepEqual(
    inspect
      .prepare("SELECT seq FROM facts")
      .all()
      .map((r) => r.seq),
    [4],
  );
  assert.equal(inspect.prepare("SELECT run FROM history_checkpoint").get()?.run, 9);
  assert.equal(inspect.prepare("SELECT COUNT(*) n FROM projection_pending").get()?.n, 1);
  assert.equal(inspect.prepare("SELECT COUNT(*) n FROM projections WHERE collection='answers'").get()?.n, 1);
  inspect.close();
  await assert.rejects(() => finalize(dest, work, key), /同一文件/);
  await finalize(dest, source, key);
  await rollback(dest, key, join(dir, "rolled-back"));
  const old = new DatabaseSync(join(dir, "rolled-back", "hub.db"), { readOnly: true });
  assert.equal(old.prepare("SELECT COUNT(*) n FROM facts").get()?.n, 4);
  old.close();

  const presence = { kind: "worker", name: "w", seen_at: "2026-01-18T00:00:00.000Z" };
  view = commit(db, view, () => [
    { ...fact(5, [{ table: "seen", key: "worker:w", row: presence }]), type: "heartbeat" },
  ]);
  assert.equal((await finalize(dest, source, key)).head, 4);
  await assert.rejects(() => rollback(dest, key, join(dir, "would-lose-presence")), /新写入/);
  view = commit(db, view, () => [fact(5, [{ table: "runs", key: "10", row: { id: 10 } }])]);
  db.close();
  const caughtUp = await finalize(dest, source, key);
  assert.equal(caughtUp.head, 5);
  await assert.rejects(() => rollback(dest, key, join(dir, "would-lose-ack")), /新写入/);
  // Simulate the matching database/sidecar from a previous engine. The new candidate has to replay the archives.
  const previous = new DatabaseSync(work);
  registerCardFunctions(previous, "fixture-key");
  const oldPath = checkpointPath(work, String(previous.prepare("SELECT sha256 FROM history_checkpoint").get()!.sha256));
  const oldCheckpoint = new DatabaseSync(oldPath);
  registerCardFunctions(oldCheckpoint, "fixture-key");
  oldCheckpoint.exec("UPDATE projection_meta SET format='previous-release'");
  oldCheckpoint.close();
  const oldDigest = fileDigest(oldPath);
  renameSync(oldPath, checkpointPath(work, oldDigest));
  previous.prepare("UPDATE history_checkpoint SET format='previous-release',sha256=?").run(oldDigest);
  previous.exec("UPDATE projection_meta SET format='previous-release'");
  previous.close();
  await assert.rejects(() => migrate(work, key, join(dir, "missing-archive")), /离线归档/);
  const archived = join(dest, "archive");
  const second = await migrate(work, key, join(dir, "again"), 0, archived);
  assert.equal(second.checkpoint, 5);
  const segment = join(
    archived,
    readdirSync(archived).find((n) => n.endsWith(".gz"))!,
  );
  const bytes = readFileSync(segment);
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  writeFileSync(segment, bytes);
  await assert.rejects(() => migrate(work, key, join(dir, "bad"), 0, archived));
});
