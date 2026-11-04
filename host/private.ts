// Secret files inherit the private directory ACL; existing files also lose any explicit grants to other users.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const protectedDirectories = new Set<string>();
function protect(file: string, directory: boolean, agent?: { sid: string; access: "read" | "edit" }) {
  if (process.platform !== "win32") return chmodSync(file, directory ? 0o700 : 0o600);
  const absolute = path.resolve(file);
  if (directory && !agent && protectedDirectories.has(absolute)) return;
  const grant = agent
    ? `$agent=New-Object Security.Principal.SecurityIdentifier('${agent.sid}'); if(!$agent.IsAccountSid()){throw 'Expected a sandbox user SID'}; $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($agent,'${agent.access === "read" ? "ReadAndExecute" : "ReadAndExecute,Write"}','ContainerInherit,ObjectInherit','None','Allow')));`
    : "";
  const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(absolute).toString("base64")}')); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object Security.AccessControl.${directory ? "DirectorySecurity" : "FileSecurity"}; $acl.SetAccessRuleProtection($true,$false); $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl',${directory ? "'ContainerInherit,ObjectInherit'" : "'None'"},'None','Allow'); $acl.AddAccessRule($rule); ${grant} [IO.${directory ? "Directory" : "File"}]::SetAccessControl($p,$acl)`;
  execFileSync(
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { stdio: "pipe", windowsHide: true },
  );
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
