// Failure modes: a sandbox cannot read its turn data; sharing data exposes hub secrets or the worker's run token;
// read access permits writes, or an account-wide group receives access instead of the actual sandbox user.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import * as privacy from "../host/private.ts";

const root = mkdtempSync(join(tmpdir(), "agent-autoloop-agent-acl-"));
after(() => rmSync(root, { recursive: true, force: true }));
const account = "S-1-5-21-1-2-3-4242";
function rules(file: string, directory = false): { sid: string; rights: number }[] {
  const code = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(file).toString("base64")}')); @([IO.${directory ? "Directory" : "File"}]::GetAccessControl($p).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{@{sid=$_.IdentityReference.Value;rights=[int64]$_.FileSystemRights}})|ConvertTo-Json -Compress`;
  const output = execFileSync(
    join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

for (const access of ["read", "edit"] as const) {
  test(
    `the ${access} agent can access only its data, with no hub or worker credentials`,
    { skip: process.platform !== "win32" },
    () => {
      const home = join(root, access);
      const control = join(home, "worker", "runs", "1-1");
      const folder = join(control, "agent");
      privacy.privateDirectory(home);
      privacy.privateDirectory(folder);
      const secrets = ["master.key", "hub.db", "secrets.env", "config.json"].map((name) => join(home, name));
      secrets.push(join(control, "entry.json"), join(control, "exit-1.launch"));
      for (const file of secrets) privacy.writePrivateFile(file, "test-only-secret");
      const data = join(folder, "context.json");
      privacy.writePrivateFile(data, "test-only-data");
      privacy.agentDirectory(folder, account, access);
      const output = join(folder, "stdout-1.log");
      writeFileSync(output, "agent output");
      for (const file of [folder, data, output]) {
        const acl = rules(file, file === folder);
        const grant = acl.find((rule) => rule.sid === account);
        assert.ok(grant, "the actual agent account needs its own ACE");
        assert.ok(grant.rights & 1, "read data");
        assert.equal(Boolean(grant.rights & 2), access === "edit", "write only for edit");
        assert.equal(grant.rights & 0xc0000, 0, "no WRITE_DAC or WRITE_OWNER");
        assert.ok(!acl.some((rule) => ["S-1-1-0", "S-1-5-32-545"].includes(rule.sid)));
      }
      for (const file of secrets) assert.ok(!rules(file).some((rule) => rule.sid === account), file);
      privacy.privateDirectory(folder);
      assert.ok(
        !rules(folder, true).some((rule) => rule.sid === account),
        "privateDirectory must revoke a previous sharing grant",
      );
    },
  );
}

test("sharing refuses broad groups and legacy control directories", { skip: process.platform !== "win32" }, () => {
  const folder = join(root, "bad");
  for (const sid of ["S-1-1-0", "S-1-5-32-545", "SID';throw 'injection"])
    assert.throws(() => privacy.agentDirectory(folder, sid, "edit"), /SID/);
  privacy.writePrivateFile(join(folder, "entry.json"), "secret");
  assert.throws(() => privacy.agentDirectory(folder, account, "edit"), /控制目录/);
});
