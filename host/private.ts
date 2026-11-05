// Secret files inherit the private directory ACL; existing files also lose any explicit grants to other users.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { aclHelper } from "./windows-acl.ts";

const protectedDirectories = new Set<string>();
function protect(file: string, directory: boolean, agent?: { sid: string; access: "read" | "edit" }) {
  if (process.platform !== "win32") return chmodSync(file, directory ? 0o700 : 0o600);
  const absolute = path.resolve(file);
  if (directory && !agent && protectedDirectories.has(absolute)) return;
  execFileSync(aclHelper(), [absolute, directory ? "directory" : "file", ...(agent ? [agent.sid, agent.access] : [])], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 5_000,
  });
  if (directory && !agent) protectedDirectories.add(absolute);
  if (agent) protectedDirectories.delete(absolute);
}

export function privateDirectory(file: string) {
  mkdirSync(file, { recursive: true, mode: 0o700 });
  protect(file, true);
}

export const privateFile = (file: string) => protect(file, false);

export function agentDirectory(file: string, sid: string, access: "read" | "edit") {
  if (process.platform !== "win32") return;
  if (!/^S-1-(?:5-21|12-1)(?:-\d+){4}$/.test(sid)) throw new Error("Agent 身份必须是具体的 Windows 用户 SID");
  // Older run folders also contain the worker's credentials.
  if (existsSync(path.join(file, "entry.json"))) throw new Error("不能把接单程序的控制目录授权给 Agent");
  if (!lstatSync(path.join(file, "context.json")).isFile()) throw new Error("本轮 context.json 必须是普通文件");
  privateDirectory(file);
  protect(file, true, { sid, access });
}

export function writePrivateFile(file: string, data: string | Uint8Array) {
  privateDirectory(path.dirname(file));
  try {
    writeFileSync(file, data, { mode: 0o600, flag: "wx" });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  privateFile(file);
  writeFileSync(file, data, { mode: 0o600 });
}
