// Secret files inherit the private directory ACL; existing files also lose any explicit grants to other users.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const protectedDirectories = new Set<string>();
function protect(file: string, directory: boolean) {
  if (process.platform !== "win32") return chmodSync(file, directory ? 0o700 : 0o600);
  const absolute = path.resolve(file);
  if (directory && protectedDirectories.has(absolute)) return;
  const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(absolute).toString("base64")}')); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object Security.AccessControl.${directory ? "DirectorySecurity" : "FileSecurity"}; $acl.SetAccessRuleProtection($true,$false); $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl',${directory ? "'ContainerInherit,ObjectInherit'" : "'None'"},'None','Allow'); $acl.AddAccessRule($rule); [IO.${directory ? "Directory" : "File"}]::SetAccessControl($p,$acl)`;
  execFileSync(
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { stdio: "pipe", windowsHide: true },
  );
  if (directory) protectedDirectories.add(absolute);
}

export function privateDirectory(file: string) {
  mkdirSync(file, { recursive: true, mode: 0o700 });
  protect(file, true);
}

export const privateFile = (file: string) => protect(file, false);

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
