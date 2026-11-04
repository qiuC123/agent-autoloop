// Failure mode: POSIX modes silently leave Windows keys readable by other local users.
import assert from "node:assert/strict";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import fs, { mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { setup } from "./helpers.ts";
import { assertPrivate } from "./private.ts";
import { privateDirectory, privateFile } from "../host/private.ts";
const home = setup("private");
const runtime = await import("../host/runtime.ts");
const { writeConfig } = await import("../host/config.ts");
test("runtime and config have owner-only permissions on the actual filesystem", () => {
  writeConfig({ url: "http://127.0.0.1", owner: "test-only" });
  assertPrivate(home, true);
  assertPrivate(join(home, "master.key"));
  assertPrivate(join(home, "config.json"));
  runtime.db.prepare("SELECT 1").get();
});

test(
  "an owner with inherited Modify can protect its directory without WRITE_OWNER",
  { skip: process.platform !== "win32" },
  () => {
    const folder = join(home, "modify-only");
    mkdirSync(folder);
    const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(folder).toString("base64")}')); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'Modify','ContainerInherit,ObjectInherit','None','Allow'))); [IO.Directory]::SetAccessControl($p,$acl)`;
    execFileSync(join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"), [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ]);
    privateDirectory(folder);
    assertPrivate(folder, true);
  },
);

function grantForeignRead(file: string) {
  const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(file).toString("base64")}')); $acl=[IO.File]::GetAccessControl($p); $sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow'))); [IO.File]::SetAccessControl($p,$acl)`;
  execFileSync(join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"), [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]);
}

test(
  "existing config temporaries lose foreign Read access before secrets are written",
  { skip: process.platform !== "win32" },
  (t) => {
    const target = join(home, "config.json.tmp");
    fs.writeFileSync(target, "old contents");
    grantForeignRead(target);
    const original = fs.writeFileSync;
    let checked = 0;
    const mocked = t.mock.method(fs, "writeFileSync", ((
      file: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions,
    ) => {
      if (
        String(file) === target &&
        String(data).includes("fresh-secret") &&
        (options === null || typeof options !== "object" || options.flag !== "wx")
      ) {
        assertPrivate(target);
        checked++;
      }
      return original(file, data, options);
    }) as typeof fs.writeFileSync);
    syncBuiltinESMExports();
    try {
      writeConfig({ url: "http://127.0.0.1", owner: "fresh-secret" });
      assert.equal(checked, 1);
      assertPrivate(join(home, "config.json"));
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  },
);

test("a recreated file at a previously protected path is checked again", { skip: process.platform !== "win32" }, () => {
  const target = join(home, "recreated.tmp");
  fs.writeFileSync(target, "first");
  privateFile(target);
  fs.rmSync(target);
  fs.writeFileSync(target, "replacement");
  grantForeignRead(target);
  privateFile(target);
  assertPrivate(target);
});
