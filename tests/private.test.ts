// Failure modes: POSIX modes leave Windows keys readable; a transient native timeout fails without retry,
// or exhausted ACL retries still publish secrets or cache an unprotected directory.
import assert from "node:assert/strict";
import cp from "node:child_process";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import fs, { mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { setup } from "./helpers.ts";
import { assertPrivate } from "./private.ts";
import { privateDirectory, privateFile, writePrivateFile } from "../host/private.ts";
import { runAclCommand } from "../host/windows-acl.ts";
const home = setup("private");
const runtime = await import("../host/runtime.ts");
const { writeConfig } = await import("../host/config.ts");
test("native ACL commands retry only timeouts, never permission failures", (t) => {
  let calls = 0;
  let code = "ETIMEDOUT";
  const mocked = t.mock.method(cp, "execFileSync", ((_program: string, _args: string[], options: any) => {
    assert.equal(options.timeout, 30_000);
    calls++;
    if (code === "EACCES" || calls === 1) throw Object.assign(new Error(code), { code });
    return "fixture";
  }) as typeof cp.execFileSync);
  syncBuiltinESMExports();
  try {
    for (const program of ["whoami.exe", "icacls.exe", "csc.exe", "acl.exe"]) {
      calls = 0;
      assert.equal(runAclCommand(program, []), "fixture");
      assert.equal(calls, 2);
    }
    code = "EACCES";
    calls = 0;
    assert.throws(() => runAclCommand("acl.exe", []), /EACCES/);
    assert.equal(calls, 1);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
test(
  "private ACLs work without PowerShell and native waits are bounded",
  { skip: process.platform !== "win32" },
  (t) => {
    const original = cp.execFileSync;
    const mocked = t.mock.method(cp, "execFileSync", ((program: string, args: string[], options: any) => {
      assert.doesNotMatch(program, /powershell/i, "ACL setup must not depend on PowerShell startup");
      assert.ok(options?.timeout > 0 && options.timeout <= 30_000, "native ACL calls need a finite deadline");
      return original(program, args, options);
    }) as typeof cp.execFileSync);
    syncBuiltinESMExports();
    try {
      const target = join(home, "no-powershell 中文 & space");
      privateDirectory(target);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assertPrivate(join(home, "no-powershell 中文 & space"), true);
  },
);
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
    execFileSync(
      join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { timeout: 30_000 },
    );
    privateDirectory(folder);
    assertPrivate(folder, true);
  },
);

function grantForeignRead(file: string) {
  const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(file).toString("base64")}')); $acl=[IO.File]::GetAccessControl($p); $sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow'))); [IO.File]::SetAccessControl($p,$acl)`;
  execFileSync(
    join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { timeout: 30_000 },
  );
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

test(
  "a native ACL timeout cannot publish secrets or cache a directory as protected",
  { skip: process.platform !== "win32" },
  (t) => {
    const target = join(home, "acl-timeout", "secret");
    mkdirSync(join(home, "acl-timeout"));
    fs.writeFileSync(target, "old contents");
    grantForeignRead(target);
    const original = cp.execFileSync;
    let calls = 0;
    const mocked = t.mock.method(cp, "execFileSync", (() => {
      calls++;
      throw Object.assign(new Error("native ACL timeout"), { code: "ETIMEDOUT" });
    }) as typeof original);
    syncBuiltinESMExports();
    try {
      assert.throws(() => writePrivateFile(target, "fresh secret"), /timeout/);
      assert.equal(calls, 2, "one retry, then fail closed");
      assert.equal(fs.readFileSync(target, "utf8"), "old contents");
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    writePrivateFile(target, "fresh secret");
    assertPrivate(join(home, "acl-timeout"), true);
    assertPrivate(target);
  },
);

test("a transient ACL timeout retries once with a 30 second deadline", { skip: process.platform !== "win32" }, (t) => {
  const target = join(home, "acl-retry", "secret");
  const original = cp.execFileSync;
  let attempts = 0;
  const mocked = t.mock.method(cp, "execFileSync", ((program: string, args: string[], options: any) => {
    if (program.endsWith("acl.exe") && args[0] === join(home, "acl-retry")) {
      attempts++;
      assert.equal(options.timeout, 30_000);
      if (attempts === 1) throw Object.assign(new Error("synthetic ACL timeout"), { code: "ETIMEDOUT" });
    }
    return original(program, args, options);
  }) as typeof original);
  syncBuiltinESMExports();
  try {
    writePrivateFile(target, "test-only");
    assert.equal(attempts, 2);
    assertPrivate(target);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
