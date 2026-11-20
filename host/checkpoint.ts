// File access belongs to the host. Candidate checks can use this module without starting a writable hub.
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { credential, digest } from "../kernel/credentials.ts";
import { sealedBase } from "../kernel/store.ts";

export function projectionFormat(secret: string) {
  const implementation = [
    "../kernel/evolve.ts",
    "../kernel/schema.sql",
    "../kernel/credentials.ts",
    "./runtime.ts",
    "./checkpoint.ts",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("\r\n", "\n"));
  return digest(implementation.join("\n") + digest(secret));
}

export function registerCardFunctions(db: DatabaseSync, secret: string) {
  const env = { secret, publicUrl: "" };
  db.function("card_token", { deterministic: true }, (id, at) => credential(env, "card", id, at));
  db.function("card_hash", { deterministic: true }, (id, at) => digest(credential(env, "card", id, at)));
}

export function indexCardHashes(db: DatabaseSync) {
  db.exec(
    "CREATE INDEX IF NOT EXISTS projection_card_hash ON projections(card_hash(json_extract(data,'$.id'),json_extract(data,'$.created_at'))) WHERE collection='cards'",
  );
}

export function fileDigest(path: string) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (let n; (n = readSync(fd, buffer)) > 0;) hash.update(buffer.subarray(0, n));
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

export function checkpointPath(database: string, sha256: string) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("检查点摘要无效");
  return join(dirname(database), `checkpoint-${sha256}.db`);
}

export function loadCheckpoint(db: DatabaseSync, format: string) {
  const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='history_checkpoint'").get();
  const record = table && db.prepare("SELECT seq,sha256,format FROM history_checkpoint WHERE id=1").get();
  const first = db.prepare("SELECT MIN(seq) AS seq FROM facts").get()!.seq;
  if (first !== null && first !== Number(record?.seq ?? 0) + 1) throw new Error("事实日志前缀或检查点登记缺失");
  if (!record) return;
  if (record.format !== format) throw new Error("检查点投影指纹不匹配，请用候选引擎和离线归档重新建点");
  const path = checkpointPath(db.location()!, String(record.sha256));
  const attached = db
    .prepare("PRAGMA database_list")
    .all()
    .find((row) => row.name === "sealed");
  if (attached?.file !== path) {
    if (fileDigest(path) !== record.sha256) throw new Error("检查点文件摘要不匹配");
    if (attached) db.exec("DETACH sealed");
    db.prepare("ATTACH ? AS sealed").run(pathToFileURL(path).href + "?mode=ro&immutable=1");
  }
  sealedBase(db, format);
}
