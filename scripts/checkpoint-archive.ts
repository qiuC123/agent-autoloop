import { createReadStream, createWriteStream, fsyncSync, openSync, closeSync, renameSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { fileDigest } from "../host/checkpoint.ts";
import { readFact } from "../kernel/store.ts";

export class MigrationError extends Error {}

export function syncFile(file: string, directory = false) {
  if (directory && process.platform === "win32") return;
  const fd = openSync(file, directory ? "r" : "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function parse(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new MigrationError("事实或归档不是有效的 JSON");
  }
}

export function* rawRange(db: DatabaseSync, after: number, end: number) {
  let seq = after;
  for (const row of db.prepare("SELECT seq,fact FROM facts WHERE seq>? AND seq<=? ORDER BY seq").iterate(after, end)) {
    if (row.seq !== ++seq) throw new MigrationError("事实前缀有缺口");
    yield String(row.fact);
  }
  if (seq !== end) throw new MigrationError("事实尾段缺失");
}

export function* facts(db: DatabaseSync, after: number, end: number) {
  let seq = after;
  for (const raw of rawRange(db, after, end)) yield readFact(raw, ++seq);
}

const pattern = /^facts-(\d+)-(\d+)-([0-9a-f]{64})\.jsonl\.gz$/;
export function archiveFiles(dir: string, end: number) {
  return readdirSync(dir)
    .filter((file) => {
      const match = pattern.exec(file);
      return match && Number(match[2]) <= end;
    })
    .sort((a, b) => Number(pattern.exec(a)![1]) - Number(pattern.exec(b)![1]))
    .map((f) => join(dir, f));
}

export async function* readSegment(file: string, identity: string, after: number) {
  const name = pattern.exec(basename(file));
  if (!name || Number(name[1]) !== after + 1 || fileDigest(file) !== name[3])
    throw new MigrationError("归档文件缺失、重叠或摘要不匹配");
  const input = createReadStream(file);
  const unzip = createGunzip();
  const transfer = pipeline(input, unzip);
  // Observe failures even when the async iterator is unwinding after a bad header.
  void transfer.catch(() => {});
  const lines = createInterface({ input: unzip, crlfDelay: Infinity });
  let header = false,
    seq = after;
  const end = Number(name[2]);
  try {
    for await (const line of lines) {
      if (!header) {
        const h = parse(line);
        if (
          h.version !== 1 ||
          h.fact_version !== 1 ||
          h.identity !== identity ||
          h.first !== after + 1 ||
          h.last !== end ||
          h.count !== end - after
        )
          throw new MigrationError("归档身份、序号或版本不匹配");
        header = true;
      } else {
        readFact(line, ++seq);
        yield line;
      }
    }
    await transfer;
    if (!header || seq !== end) throw new MigrationError("归档事实条数不匹配");
  } finally {
    lines.close();
    input.destroy();
    unzip.destroy();
  }
}

export async function sealSegment(db: DatabaseSync, dir: string, identity: string, after: number, end: number) {
  const tmp = join(dir, "writing.gz");
  function* lines() {
    yield JSON.stringify({ version: 1, fact_version: 1, identity, first: after + 1, last: end, count: end - after }) +
      "\n";
    for (const raw of rawRange(db, after, end)) yield raw + "\n";
  }
  await pipeline(Readable.from(lines()), createGzip(), createWriteStream(tmp, { mode: 0o600, flags: "wx" }));
  syncFile(tmp);
  const file = join(dir, `facts-${after + 1}-${end}-${fileDigest(tmp)}.jsonl.gz`);
  renameSync(tmp, file);
  syncFile(dir, true);
  const original = rawRange(db, after, end);
  try {
    for await (const line of readSegment(file, identity, after))
      if (original.next().value !== line) throw new MigrationError("归档内容与原始事实不一致");
    if (!original.next().done) throw new MigrationError("归档缺少事实");
  } finally {
    original.return();
  }
  return file;
}
