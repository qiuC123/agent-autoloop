// Check the actual DACL, since Windows stat.mode does not express who can read a secret.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

export function assertPrivate(file: string, directory = false) {
  if (process.platform !== "win32") return assert.equal(statSync(file).mode & 0o777, directory ? 0o700 : 0o600);
  const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(file).toString("base64")}')); $acl=[IO.${directory ? "Directory" : "File"}]::GetAccessControl($p); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); if($rules.Count -eq 0){throw 'Empty ACL'}; foreach($r in $rules){if($r.IdentityReference.Value -ne $sid -or $r.AccessControlType -ne 'Allow'){throw 'Foreign ACL grant'}}; 'private'`;
  const result = execFileSync(
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8" },
  );
  assert.match(result, /private/);
}
