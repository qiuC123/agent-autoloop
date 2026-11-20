// The log and its expendable projection commit together. Only this module appends facts.
import type { DatabaseSync } from "node:sqlite";
import { Conflict } from "./errors.ts";
import {
  compactHeartbeats,
  evolve,
  initialize,
  restoreHeartbeatState,
  restoreSealed,
  statement,
  View,
  type Fact,
} from "./evolve.ts";

export function historyBoundary(db: DatabaseSync): { seq: number; run: number } {
  const row = statement(db, "SELECT seq,run FROM history_checkpoint WHERE id=1").get();
  return { seq: Number(row?.seq ?? 0), run: Number(row?.run ?? 0) };
}

export function readLog(db: DatabaseSync, after = 0): Fact[] {
  return [...iterateLog(db, after)];
}
export function readFact(raw: string, seq: number): Fact {
  let fact: Fact;
  try {
    fact = JSON.parse(raw);
  } catch {
    throw new Error(`事实 ${seq} 的 JSON 损坏`);
  }
  if (fact?.version !== 1 || fact.seq !== seq || !Array.isArray(fact.changes))
    throw new Error(`事实 ${seq} 的版本、序号或内容不受支持`);
  return fact;
}
export function* iterateLog(db: DatabaseSync, after = 0): Generator<Fact> {
  let expected = after + 1;
  for (const row of db.prepare("SELECT seq,fact FROM facts WHERE seq > ? ORDER BY seq").iterate(after)) {
    if (row.seq !== expected++) throw new Error("事实日志序号不连续");
    yield readFact(String(row.fact), Number(row.seq));
  }
}
function transaction(db: DatabaseSync, work: () => View): View {
  db.exec("BEGIN IMMEDIATE");
  try {
    const view = work();
    db.exec("COMMIT");
    return view;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function sealedBase(db: DatabaseSync, format: string) {
  const boundary = statement(db, "SELECT * FROM history_checkpoint WHERE id=1").get();
  if (!boundary) return;
  const info = statement(db, "SELECT identity,version,fact_version,seq FROM sealed.checkpoint_info WHERE id=1").get();
  const meta = statement(db, "SELECT seq,next,format FROM sealed.projection_meta WHERE id=1").get();
  const next = JSON.parse(String(meta?.next)) as Record<string, number>;
  if (
    info?.version !== 1 ||
    info.fact_version !== 1 ||
    info.seq !== boundary.seq ||
    info.identity !== boundary.identity ||
    meta?.seq !== boundary.seq ||
    (next.runs ?? 0) !== boundary.run ||
    meta.format !== format ||
    boundary.format !== format ||
    !Number.isSafeInteger(boundary.seq) ||
    Number(boundary.seq) <= 0
  )
    throw new Error("检查点身份、序号、版本或投影指纹不匹配");
  const tail = statement(
    db,
    "SELECT (SELECT COUNT(*) FROM facts) AS n, (SELECT MIN(seq) FROM facts) AS first, (SELECT MAX(seq) FROM facts) AS last",
  ).get()!;
  if (tail.n && (tail.first !== Number(boundary.seq) + 1 || Number(tail.last) - Number(boundary.seq) !== tail.n))
    throw new Error("检查点后的事实日志序号不连续");
  return new View(db, Number(boundary.seq), next, format);
}
export const rebuild = (db: DatabaseSync, format = "") => {
  initialize(db);
  return transaction(db, () => {
    const sealed = sealedBase(db, format);
    const head = Number(statement(db, "SELECT MAX(seq) AS seq FROM facts").get()!.seq ?? sealed?.seq ?? 0);
    const saved = statement(db, "SELECT seq FROM projection_meta WHERE id=1").get();
    if (Number(saved?.seq ?? 0) > head) throw new Error("事实日志尾段缺失");
    const base = sealed ? restoreSealed(db, sealed.seq, sealed.next, format) : new View(db, 0, {}, format);
    const view = evolve(base, iterateLog(db, base.seq), db, !sealed);
    restoreHeartbeatState(db);
    return view;
  });
};
export function openView(db: DatabaseSync, format: string) {
  initialize(db);
  const saved = statement(
    db,
    "SELECT seq,next,format,COALESCE((SELECT MAX(seq) FROM facts),(SELECT seq FROM history_checkpoint WHERE id=1),0) AS head FROM projection_meta WHERE id=1",
  ).get();
  if (!saved || saved.format !== format || saved.seq !== saved.head) return rebuild(db, format);
  return new View(db, Number(saved.seq), JSON.parse(String(saved.next)), format);
}
export function commit(db: DatabaseSync, view: View, produce: () => Fact[]): View {
  initialize(db);
  return transaction(db, () => {
    const latest = Number(
      statement(
        db,
        "SELECT COALESCE(MAX(seq),(SELECT seq FROM history_checkpoint WHERE id=1),0) AS seq FROM facts",
      ).get()!.seq,
    );
    if (latest !== view.seq) throw new Conflict("日志已变化，请重读后再提交");
    const facts = compactHeartbeats(db, produce());
    if (!facts.length) return view;
    const insert = statement(db, "INSERT INTO facts(seq,fact) VALUES (?,?)");
    for (const fact of facts) insert.run(fact.seq, JSON.stringify(fact));
    return evolve(view, facts, db);
  });
}
