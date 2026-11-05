// Host control, separate from replayable business facts. Call only inside the runtime's commit transaction.
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, Conflict, InputError } from "../kernel/errors.ts";
import { digest, whose } from "../kernel/credentials.ts";
import { rows, type View } from "../kernel/evolve.ts";
import { dateTime } from "../protocol/validate.ts";
import { HOME } from "./home.ts";
import { writePrivateFile } from "./private.ts";

type Record = {
  mode: "normal" | "draining" | "held";
  id: string | null;
  entered_at: string | null;
  deadline: string | null;
};
const initial: Record = { mode: "normal", id: null, entered_at: null, deadline: null };
const file = join(HOME, "maintenance.json");
const uuid = (id: unknown) => typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
function sync(file: string, flags = "r+") {
  const fd = openSync(file, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function write(record: Record) {
  const temp = `${file}.tmp`;
  try {
    writePrivateFile(temp, `${JSON.stringify(record)}\n`);
    sync(temp);
    renameSync(temp, file);
    if (process.platform !== "win32") sync(HOME, "r");
  } finally {
    rmSync(temp, { force: true });
  }
}

export function readMaintenance(): Record & { problem: string | null } {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    const fields = value && Object.keys(value).sort().join() === "deadline,entered_at,id,mode";
    const empty = value?.mode === "normal" && value.id === null && value.entered_at === null && value.deadline === null;
    const dated =
      uuid(value?.id) &&
      dateTime(value?.entered_at) &&
      dateTime(value?.deadline) &&
      Date.parse(value.deadline) >= Date.parse(value.entered_at);
    if (!fields || !["normal", "draining", "held"].includes(value.mode) || !(empty || dated))
      throw new Error("invalid");
    return { ...value, problem: null };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      ...initial,
      mode: "draining",
      problem: missing ? "维护文件缺失，已暂停领取" : "维护文件不可读或格式错误，已暂停领取",
    };
  }
}

export function initializeMaintenance(db: DatabaseSync) {
  // This host-only marker distinguishes a legacy install from a deleted control file, even after projection rebuilds.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS host_maintenance (initialized INTEGER PRIMARY KEY CHECK(initialized=1))");
    if (!db.prepare("SELECT initialized FROM host_maintenance").get()) {
      try {
        readFileSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") write(initial);
      }
      db.prepare("INSERT INTO host_maintenance VALUES(1)").run();
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function maintenance(view: View, token: string, input: unknown, now: number) {
  if (!whose(view, "owner", token)) throw new AuthError("要本人自己的密钥");
  const status = readMaintenance();
  const claimed = rows(view, "runs", { state: "claimed" }).length;
  const unknown = rows(view, "runs", { state: "unknown" }).length;
  let next: Record = status;
  if (input !== undefined) {
    const given = input as { action?: string; id?: string; deadline?: string } | null;
    const action = given?.action;
    const fields = action === "drain" ? "action,deadline" : action === "renew" ? "action,deadline,id" : "action,id";
    if (
      !given ||
      !["drain", "hold", "renew", "resume"].includes(action!) ||
      Object.keys(given).sort().join() !== fields ||
      (action !== "drain" && (typeof given.id !== "string" || !given.id || given.id.length > 200)) ||
      (["drain", "renew"].includes(action!) && !dateTime(given.deadline))
    )
      throw new InputError("维护动作或字段不正确");
    if (action === "drain") {
      if (status.mode === "normal" || status.problem) {
        if (Date.parse(given.deadline!) <= now) throw new InputError("维护期限必须在将来");
        next = {
          mode: "draining",
          id: randomUUID(),
          entered_at: new Date(now).toISOString(),
          deadline: given.deadline!,
        };
      }
    } else {
      if (status.problem || given.id !== status.id) throw new Conflict("维护编号不匹配，请重新核对");
      if (action === "resume") {
        if (status.mode !== "normal" && Date.parse(status.deadline!) <= now)
          throw new Conflict("维护期限已到，请核对后续期再恢复");
        next = { ...status, mode: "normal" };
      } else {
        if (status.mode === "normal") throw new Conflict("这次维护已结束");
        if (action === "hold") {
          if (claimed || unknown) throw new Conflict("还有已领取或状态不确定的任务");
          next = { ...status, mode: "held" };
        } else {
          if (Date.parse(given.deadline!) < Date.parse(status.deadline!)) throw new Conflict("不能缩短维护期限");
          if (given.deadline !== status.deadline && Date.parse(given.deadline!) <= now)
            throw new InputError("维护期限必须在将来");
          next = { ...status, deadline: given.deadline! };
        }
      }
    }
  }
  const record = { mode: next.mode, id: next.id, entered_at: next.entered_at, deadline: next.deadline };
  const changed = Object.keys(record).some((key) => record[key as keyof Record] !== status[key as keyof Record]);
  if (changed) write(record);
  const rules = view.get("config", "rules")!;
  return {
    changed,
    status: {
      ...record,
      problem: changed ? null : status.problem,
      expired: record.mode !== "normal" && record.deadline !== null && Date.parse(record.deadline) <= now,
      claimed,
      unknown,
      rules_version: rules.version,
      rules_hash: digest(JSON.stringify(rules.value)),
    },
  };
}
