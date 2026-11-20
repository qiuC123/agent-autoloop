// Candidate entry point for a consistent backup. Never import the live runtime or open the source for writes.
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadCheckpoint, projectionFormat, registerCardFunctions } from "../host/checkpoint.ts";
import { privateDirectory } from "../host/private.ts";
import { copyHeartbeatState, evolve, initialize, restoreHeartbeatState, View } from "../kernel/evolve.ts";
import { iterateLog } from "../kernel/store.ts";

export const MAX_TAIL_FACTS = 2048;
export const MAX_TAIL_BYTES = 4 * 1024 * 1024;
class ReplayCheckError extends Error {}

export function replayCheck(file: string, secret: string) {
  const started = performance.now(),
    format = projectionFormat(secret);
  const source = new DatabaseSync(file, { readOnly: true });
  let dir: string | undefined, target: DatabaseSync | undefined;
  try {
    registerCardFunctions(source, secret);
    source.exec("BEGIN");
    loadCheckpoint(source, format);
    const sealed = source
      .prepare("PRAGMA database_list")
      .all()
      .find((row) => row.name === "sealed");
    let checkpoint_seq = 0,
      next: Record<string, number> = {};
    if (sealed) {
      const meta = source.prepare("SELECT seq,next FROM sealed.projection_meta WHERE id=1").get()!;
      checkpoint_seq = Number(meta.seq);
      next = JSON.parse(String(meta.next));
      const size = source
        .prepare(
          "SELECT count(*) AS n, sum(bytes) AS bytes FROM (SELECT length(CAST(fact AS BLOB)) AS bytes FROM facts ORDER BY seq LIMIT ?)",
        )
        .get(MAX_TAIL_FACTS + 1)!;
      if (Number(size.n) > MAX_TAIL_FACTS || Number(size.bytes) > MAX_TAIL_BYTES)
        throw new ReplayCheckError("尾段超出上线检查预算，请先建检查点");
      dir = mkdtempSync(join(tmpdir(), "checkpoint-replay-"));
      privateDirectory(dir);
      const copy = join(dir, "replay.db");
      copyFileSync(String(sealed.file), copy);
      target = new DatabaseSync(copy);
    } else target = new DatabaseSync(":memory:");
    registerCardFunctions(target, secret);
    initialize(target);
    target.exec("BEGIN");
    const startReplay = performance.now();
    const view = evolve(new View(target, checkpoint_seq, next, format), iterateLog(source, checkpoint_seq));
    copyHeartbeatState(source, target);
    restoreHeartbeatState(target);
    const replay_ms = performance.now() - startReplay;
    const meta = source.prepare("SELECT seq,next FROM projection_meta WHERE id=1").get();
    if (view.seq !== meta?.seq || JSON.stringify(view.next) !== meta.next)
      throw new ReplayCheckError("重放序号或编号高水位不匹配");
    return {
      checkpoint_seq,
      seq: view.seq,
      count: view.seq - checkpoint_seq,
      replay_ms,
      total_ms: performance.now() - started,
    };
  } finally {
    target?.close();
    source.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const [file, keyFile, ...extra] = process.argv.slice(2);
    if (!file || !keyFile || extra.length)
      throw new ReplayCheckError("用法：node scripts/replay-check.ts <一致副本> <主密钥文件>");
    console.log(JSON.stringify(replayCheck(file, readFileSync(keyFile, "utf8").trim())));
  } catch (error) {
    console.error(
      error instanceof ReplayCheckError ? error.message : "重放验证失败，请核对数据库、检查点文件、版本与主密钥",
    );
    process.exitCode = 1;
  }
}
