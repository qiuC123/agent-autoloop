import { randomUUID } from "node:crypto";
import { constants, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  checkpointPath,
  fileDigest,
  indexCardHashes,
  loadCheckpoint,
  projectionFormat,
  registerCardFunctions,
} from "../host/checkpoint.ts";
import { privateDirectory, privateFile } from "../host/private.ts";
import { copyHeartbeatState, evolve, initialize, restoreHeartbeatState, View, type Fact } from "../kernel/evolve.ts";
import { readFact, rebuild } from "../kernel/store.ts";
import {
  MigrationError,
  archiveFiles,
  facts,
  rawRange,
  readSegment,
  sealSegment,
  syncFile,
} from "./checkpoint-archive.ts";
import { MAX_TAIL_FACTS, MAX_TAIL_BYTES } from "./replay-check.ts";

type Registration = { identity: string; seq: number; run: number; sha256: string; format: string };
type Prior = Pick<Registration, "identity" | "seq">;

function has(db: DatabaseSync, table: string) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
function registration(db: DatabaseSync): Registration | undefined {
  if (has(db, "history_checkpoint"))
    return db.prepare("SELECT * FROM history_checkpoint WHERE id=1").get() as Registration | undefined;
}
function head(db: DatabaseSync) {
  const { seq } = db.prepare("SELECT coalesce(max(seq),0) seq FROM facts").get()!;
  return Math.max(Number(seq), registration(db)?.seq ?? 0);
}
function secretAt(file: string) {
  const secret = readFileSync(file, "utf8").trim();
  if (!secret) throw new MigrationError("主密钥文件为空");
  return secret;
}
function open(file: string, secret: string, readOnly = false) {
  const db = new DatabaseSync(file, { readOnly });
  registerCardFunctions(db, secret);
  db.exec("PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=5000");
  return db;
}
function newDirectory(dir: string) {
  mkdirSync(dir, { mode: 0o700 });
  privateDirectory(dir);
}
function copy(src: string, dest: string) {
  copyFileSync(src, dest, constants.COPYFILE_EXCL);
  privateFile(dest);
}
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function backupTo(source: string, dest: string, secret: string) {
  const db = open(source, secret, true);
  try {
    db.exec("BEGIN");
    const prior = registration(db);
    await backup(db, dest, { rate: 4096 });
    privateFile(dest);
    if (prior) {
      const cp = checkpointPath(source, prior.sha256);
      const target = checkpointPath(dest, prior.sha256);
      copy(cp, target);
      if (fileDigest(target) !== prior.sha256) throw new MigrationError("备份的检查点摘要不匹配");
    }
  } finally {
    db.close();
  }
}
function integrity(db: DatabaseSync) {
  if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
    throw new MigrationError("数据库完整性或主密钥核验失败");
}
function tailBoundary(db: DatabaseSync, prev: number, total: number, keep: number) {
  if (!Number.isSafeInteger(keep) || keep < 0 || keep > MAX_TAIL_FACTS)
    throw new MigrationError("尾段条数应在 0 到 2048 之间");
  // Last-seen updates overwrite their predecessors; only the current snapshot can seal those values.
  if (has(db, "heartbeat_state") && db.prepare("SELECT 1 FROM heartbeat_state LIMIT 1").get()) return total;
  let boundary = total,
    bytes = 0;
  for (const r of db
    .prepare("SELECT seq,length(CAST(fact AS blob)) bytes FROM facts WHERE seq>? ORDER BY seq DESC LIMIT ?")
    .iterate(prev + (prev === 0 ? 1 : 0), keep)) {
    if (bytes + Number(r.bytes) > MAX_TAIL_BYTES) break;
    bytes += Number(r.bytes);
    boundary = Number(r.seq) - 1;
  }
  return boundary;
}

function tableRows(db: DatabaseSync, table: string, from: number, omitFormat = false) {
  const order =
    table === "projections" || table === "heartbeat_state" ? "1,2" : table === "projection_refs" ? "1,2,3" : "1";
  if (table === "heartbeat_state" && !has(db, table)) return [][Symbol.iterator]();
  const columns = table === "projection_meta" && omitFormat ? "id,seq,next" : "*";
  return db
    .prepare(
      "SELECT " +
        columns +
        " FROM " +
        table +
        (table === "projection_refs" ? " WHERE seq>" + from : "") +
        " ORDER BY " +
        order,
    )
    .iterate();
}
function compare(
  left: DatabaseSync,
  right: DatabaseSync,
  from: number,
  omitFormat = false,
  tables = ["projections", "projection_meta", "projection_pending", "projection_refs", "heartbeat_state"],
) {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const a = tableRows(left, table, from, omitFormat),
      b = tableRows(right, table, from, omitFormat);
    let n = 0;
    try {
      for (;;) {
        const x = a.next(),
          y = b.next();
        if (x.done !== y.done || (!x.done && JSON.stringify(x.value) !== JSON.stringify(y.value)))
          throw new MigrationError("逐项对账失败：" + table + " 第 " + (n + 1) + " 行");
        if (x.done) break;
        n++;
      }
    } finally {
      a.return?.();
      b.return?.();
    }
    counts[table] = n;
  }
  return counts;
}
function copyHeartbeats(from: DatabaseSync, to: DatabaseSync) {
  copyHeartbeatState(from, to);
  restoreHeartbeatState(to);
}

export function installSeal(db: DatabaseSync, prior: Prior | undefined, record: Registration) {
  transaction(db, () => {
    const old = registration(db);
    if (old?.seq !== prior?.seq || old?.identity !== prior?.identity || (old && old.identity !== record.identity))
      throw new MigrationError("归档边界已变化");
    const start = old?.seq ?? 0;
    const count = db.prepare("SELECT count(*) n FROM facts WHERE seq>? AND seq<=?").get(start, record.seq)!.n;
    if (record.seq < start || count !== record.seq - start || record.seq > head(db))
      throw new MigrationError("封存序号不连续");
    db.prepare("INSERT OR REPLACE INTO history_checkpoint(id,identity,seq,run,sha256,format) VALUES(1,?,?,?,?,?)").run(
      record.identity,
      record.seq,
      record.run,
      record.sha256,
      record.format,
    );
    db.prepare("DELETE FROM facts WHERE seq<=?").run(record.seq);
    db.prepare("DELETE FROM projection_refs WHERE seq<=?").run(record.seq);
  });
}

function checkpoint(view: View, work: string, identity: string, secret: string): Registration {
  const db = view.db;
  const tmp = join(dirname(work), "building-checkpoint.db");
  const seed = open(tmp, secret);
  try {
    initialize(seed);
    seed.exec(
      "CREATE TABLE checkpoint_info(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,fact_version INTEGER NOT NULL,identity TEXT NOT NULL,seq INTEGER NOT NULL)",
    );
    db.prepare("ATTACH DATABASE ? AS building").run(tmp);
    const tables = ["projections", "projection_meta", "projection_pending", "heartbeat_state"];
    try {
      transaction(db, () => {
        for (const table of tables) db.exec(`INSERT INTO building.${table} SELECT * FROM main.${table}`);
        db.prepare("INSERT INTO building.checkpoint_info VALUES(1,1,1,?,?)").run(identity, view.seq);
      });
    } finally {
      db.exec("DETACH DATABASE building");
    }
    indexCardHashes(seed);
    integrity(seed);
    compare(db, seed, view.seq, false, tables);
  } finally {
    seed.close();
  }
  privateFile(tmp);
  syncFile(tmp);
  const sha256 = fileDigest(tmp);
  renameSync(tmp, checkpointPath(work, sha256));
  syncFile(dirname(work), true);
  return { identity, seq: view.seq, run: view.next.runs ?? 0, sha256, format: view.format };
}

export async function migrate(source: string, key: string, dest: string, keep = MAX_TAIL_FACTS, archives?: string) {
  const secret = secretAt(key),
    format = projectionFormat(secret);
  newDirectory(dest);
  const backupDir = join(dest, "backup"),
    workDir = join(dest, "work"),
    archiveDir = join(dest, "archive");
  for (const dir of [backupDir, workDir, archiveDir]) mkdirSync(dir, { mode: 0o700 });
  const original = join(backupDir, "hub.db"),
    work = join(workDir, "hub.db");
  const stagingFile = join(workDir, "staging.db"),
    compactFile = join(workDir, "compact.db");
  const times: Record<string, number> = {};
  async function timed<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      times[name] = Math.round(performance.now() - start);
    }
  }
  await timed("backupMs", () => backupTo(source, original, secret));
  const input = open(original, secret, true);
  const reference = open(":memory:", secret);
  let stage: DatabaseSync | undefined;
  try {
    const prior = registration(input),
      start = prior?.seq ?? 0,
      total = head(input);
    if (!total) throw new MigrationError("没有可封存的事实");
    if (prior) loadCheckpoint(input, prior.format);
    if (Number(input.prepare("SELECT seq FROM projection_meta WHERE id=1").get()?.seq) !== total)
      throw new MigrationError("源投影水位与事实末尾不一致");
    const end = tailBoundary(input, start, total, keep),
      identity = prior?.identity ?? randomUUID();
    initialize(reference);
    let view = new View(reference, 0, {}, format);
    await timed("fullPrefixReplayMs", async () => {
      reference.exec("BEGIN");
      try {
        if (prior) {
          if (!archives) throw new MigrationError("全量对账需要提供之前的离线归档目录");
          let batch: Fact[] = [],
            seq = 0;
          for (const file of archiveFiles(archives, start)) {
            for await (const raw of readSegment(file, identity, seq)) {
              batch.push(readFact(raw, ++seq));
              if (batch.length >= 1024) {
                view = evolve(view, batch);
                batch = [];
              }
            }
          }
          view = evolve(view, batch);
          if (seq !== start) throw new MigrationError("离线归档没有覆盖原检查点");
        }
        view = evolve(view, facts(input, start, end));
        if (end === total) copyHeartbeats(input, reference);
        reference.exec("COMMIT");
      } catch (error) {
        reference.exec("ROLLBACK");
        throw error;
      }
    });
    const record = await timed("checkpointMs", () => checkpoint(view, work, identity, secret));
    const segment =
      end > start
        ? await timed("archiveAndVerifyMs", () => sealSegment(input, archiveDir, identity, start, end))
        : undefined;
    await timed("fullTailReplayMs", () =>
      transaction(reference, () => {
        view = evolve(view, facts(input, end, total));
        copyHeartbeats(input, reference);
      }),
    );
    times.fullReplayMs = times.fullPrefixReplayMs + times.fullTailReplayMs;
    await timed("sourceAuditMs", () => {
      integrity(input);
      compare(reference, input, start, true);
    });
    await timed("stageCopyMs", () => copy(original, stagingFile));
    stage = open(stagingFile, secret);
    initialize(stage);
    if (fileDigest(checkpointPath(work, record.sha256)) !== record.sha256)
      throw new MigrationError("检查点文件摘要不匹配");
    await timed("installSealMs", () => installSeal(stage!, prior, record));
    // Build the candidate from the immutable checkpoint and the retained tail, independently of the full replay.
    await timed("checkpointReplayMs", () => {
      loadCheckpoint(stage!, format);
      rebuild(stage!, format);
      indexCardHashes(stage!);
    });
    await timed("vacuumMs", () => stage!.prepare("VACUUM INTO ?").run(compactFile));
    stage.close();
    stage = undefined;
    const compact = open(compactFile, secret, true);
    let counts;
    try {
      counts = await timed("compactAuditMs", () => {
        integrity(compact);
        const expected = rawRange(input, end, total),
          actual = rawRange(compact, end, total);
        for (const line of expected) if (actual.next().value !== line) throw new MigrationError("保留的原始事实不同");
        if (!actual.next().done) throw new MigrationError("保留的原始事实多于备份");
        return compare(reference, compact, end);
      });
    } finally {
      compact.close();
    }
    syncFile(compactFile);
    privateFile(compactFile);
    renameSync(compactFile, work);
    syncFile(workDir, true);
    return {
      checkpoint: end,
      head: total,
      tail: total - end,
      counts,
      times,
      bytes: {
        before: statSync(original).size,
        work: statSync(work).size,
        checkpoint: statSync(checkpointPath(work, record.sha256)).size,
        archive: segment ? statSync(segment).size : 0,
      },
    };
  } finally {
    stage?.close();
    reference.close();
    input.close();
    rmSync(stagingFile, { force: true });
  }
}
function sameRow(a: DatabaseSync, b: DatabaseSync, seq: number) {
  const sql = "SELECT fact FROM facts WHERE seq=?";
  if (a.prepare(sql).get(seq)?.fact !== b.prepare(sql).get(seq)?.fact)
    throw new MigrationError("备份与最终库的事实锚点不一致");
}
export async function finalize(dest: string, source: string, key: string) {
  const started = performance.now(),
    secret = secretAt(key),
    format = projectionFormat(secret);
  const originalPath = join(dest, "backup", "hub.db"),
    workPath = join(dest, "work", "hub.db");
  const writable = statSync(workPath, { bigint: true });
  if (
    [source, key, originalPath].some((file) => {
      const input = statSync(file, { bigint: true });
      return input.dev === writable.dev && input.ino === writable.ino;
    })
  )
    throw new MigrationError("预建工作库与只读输入指向同一文件");
  const original = open(originalPath, secret, true);
  const final = open(source, secret, true);
  const work = open(workPath, secret);
  try {
    final.exec("BEGIN");
    const initial = head(original),
      total = head(final);
    const base = registration(original),
      prior = registration(final),
      record = registration(work);
    if (!record || record.format !== format || prior?.identity !== base?.identity || prior?.sha256 !== base?.sha256)
      throw new MigrationError("最终副本的身份、归档边界或引擎指纹不匹配");
    if (initial < (base?.seq ?? 0) || total < initial) throw new MigrationError("最终库缺少备份后的事实");
    // A pre-retention database has no UUID. The anchored facts identify its original append-only prefix.
    if (initial > (base?.seq ?? 0)) {
      sameRow(original, final, (base?.seq ?? 0) + 1);
      sameRow(original, final, initial);
    }
    const added = transaction(work, () => {
      const current = head(work);
      if (current < initial || total < current) throw new MigrationError("预建库与最终库的水位不匹配");
      if (total - record.seq > MAX_TAIL_FACTS) throw new MigrationError("检查点后尾段超过 2048 条，请重新预建");
      const retained = work.prepare("SELECT coalesce(sum(length(CAST(fact AS blob))),0) n FROM facts").get()!;
      const workTail = rawRange(work, record.seq, current);
      for (const raw of rawRange(final, record.seq, current))
        if (workTail.next().value !== raw) throw new MigrationError("预建库与最终副本的原始事实不一致");
      if (!workTail.next().done) throw new MigrationError("预建库尾段过长");
      const meta = work.prepare("SELECT seq,next,format FROM projection_meta WHERE id=1").get();
      if (meta?.seq !== current || meta.format !== format) throw new MigrationError("预建库的投影水位或指纹不匹配");
      const add: Fact[] = [];
      let bytes = Number(retained.n);
      if (bytes > MAX_TAIL_BYTES) throw new MigrationError("检查点后尾段超过 4 MiB，请重新预建");
      const insert = work.prepare("INSERT INTO facts(seq,fact) VALUES(?,?)");
      for (const raw of rawRange(final, current, total)) {
        bytes += Buffer.byteLength(raw);
        if (bytes > MAX_TAIL_BYTES) throw new MigrationError("检查点后尾段超过 4 MiB，请重新预建");
        const f = readFact(raw, current + add.length + 1);
        insert.run(f.seq, raw);
        add.push(f);
      }
      const view = evolve(new View(work, current, JSON.parse(String(meta.next)), format), add);
      copyHeartbeats(final, work);
      const expected = final.prepare("SELECT seq,next FROM projection_meta WHERE id=1").get();
      if (view.seq !== expected?.seq || JSON.stringify(view.next) !== expected.next)
        throw new MigrationError("最终投影水位或编号高水位不一致");
      // For the final stopped interval, check only keys touched since the prebuilt snapshot.
      const touched = new Map<string, { table: string; key: string }>();
      for (const f of add) for (const change of f.changes) touched.set(change.table + ":" + change.key, change);
      if (has(final, "heartbeat_state"))
        for (const r of final.prepare("SELECT collection,key FROM heartbeat_state").iterate())
          touched.set(r.collection + ":" + r.key, { table: String(r.collection), key: String(r.key) });
      const sql = "SELECT data FROM projections WHERE collection=? AND key=?";
      const take = work.prepare(sql),
        want = final.prepare(sql);
      for (const { table, key } of touched.values())
        if (take.get(table, key)?.data !== want.get(table, key)?.data)
          throw new MigrationError("停写后新增的投影对账失败");
      return add.length;
    });
    return { head: total, added, finalizeMs: Math.round(performance.now() - started) };
  } finally {
    work.close();
    final.close();
    original.close();
  }
}

export async function rollback(dest: string, key: string, output: string) {
  const started = performance.now(),
    secret = secretAt(key);
  const backupFile = join(dest, "backup", "hub.db");
  const original = open(backupFile, secret, true),
    work = open(join(dest, "work", "hub.db"), secret, true);
  try {
    work.exec("BEGIN");
    const before = head(original);
    if (head(work) !== before) throw new MigrationError("有新写入，恢复备份会丢数据");
    const { seq } = registration(work) ?? {};
    if (!seq) throw new MigrationError("预建库缺少检查点");
    for (let i = seq + 1; i <= before; i++) sameRow(original, work, i);
    const a = tableRows(original, "heartbeat_state", 0),
      b = tableRows(work, "heartbeat_state", 0);
    try {
      for (;;) {
        const x = a.next(),
          y = b.next();
        if (x.done !== y.done || (!x.done && JSON.stringify(x.value) !== JSON.stringify(y.value)))
          throw new MigrationError("有新写入，恢复备份会丢心跳状态");
        if (x.done) break;
      }
    } finally {
      a.return?.();
      b.return?.();
    }
    newDirectory(output);
    const restored = join(output, "hub.db");
    copy(backupFile, restored);
    if (fileDigest(restored) !== fileDigest(backupFile)) throw new MigrationError("恢复文件与备份摘要不同");
    const prior = registration(original);
    if (prior) {
      const cp = checkpointPath(restored, prior.sha256);
      copy(checkpointPath(backupFile, prior.sha256), cp);
      if (fileDigest(cp) !== prior.sha256) throw new MigrationError("恢复的检查点文件摘要不同");
    }
    const reopened = open(restored, secret, true);
    try {
      if (head(reopened) !== before) throw new MigrationError("恢复库水位不一致");
    } finally {
      reopened.close();
    }
    return { head: before, rollbackMs: Math.round(performance.now() - started) };
  } finally {
    original.close();
    work.close();
  }
}

if (import.meta.main) {
  const [action, a, b, c, d, e, ...extra] = process.argv.slice(2);
  try {
    if (!a || !b || !c || extra.length || (action !== "migrate" && d)) throw new MigrationError("请核对命令参数");
    const result =
      action === "migrate"
        ? await migrate(a, b, c, d === undefined ? MAX_TAIL_FACTS : Number(d), e)
        : action === "finalize"
          ? await finalize(a, b, c)
          : action === "rollback"
            ? await rollback(a, b, c)
            : undefined;
    if (!result)
      throw new MigrationError(
        "使用 migrate <副本> <主密钥文件> <新目录> [尾段条数] [归档目录]，finalize <迁移目录> <停写副本> <主密钥文件>，或 rollback <迁移目录> <主密钥文件> <新目录>",
      );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    // SQLite data and JSON parser errors can contain private text. Only our own diagnostics are printable.
    console.error(error instanceof MigrationError ? error.message : "迁移失败，请核对输入文件、数据库完整性及候选格式");
    process.exitCode = 1;
  }
}
