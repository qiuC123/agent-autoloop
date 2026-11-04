// Failure modes: drive-relative or root-relative paths are trusted, UNC paths are rejected, or Windows launch arguments reach a shell.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseRules } from "../protocol/rules.ts";
import { command } from "../host/command.ts";

const folder = mkdtempSync(join(tmpdir(), "agent-autoloop-platform-"));
after(() => rmSync(folder, { recursive: true, force: true }));
test("rules accept absolute Windows directories and reject ambiguous relative paths", () => {
  const rules = {
    sources: { local: { name: "local" } },
    agents: { local: { name: "local", worker: "local", use: "command", command: ["node"] } },
    channels: {},
    rules: [{ name: "local", when: { source: "local", types: ["try"] }, to: "local", cwd: "" }],
  };
  for (const cwd of ["C:\\work", "E:/work", "\\\\server\\share\\work", "~/work", "~\\work", "/work"]) {
    rules.rules[0].cwd = cwd;
    assert.doesNotThrow(() => parseRules(JSON.stringify(rules), Date.now(), "UTC"), cwd);
  }
  for (const cwd of ["C:work", "\\work", "relative", "\\\\server", "~work"]) {
    rules.rules[0].cwd = cwd;
    assert.throws(() => parseRules(JSON.stringify(rules), Date.now(), "UTC"), { name: "Error" }, cwd);
  }
});
test(
  "Windows resolves a Node shim without interpreting argument metacharacters",
  { skip: process.platform !== "win32" },
  () => {
    const entry = join(folder, "entry.cjs");
    const shim = join(folder, "entry.cmd");
    writeFileSync(entry, "console.log(process.argv.slice(2))");
    writeFileSync(shim, '@ECHO OFF\r\n@node "%~dp0\\entry.cjs" %*\r\n');
    const args = ['" & echo injected', "%USERPROFILE%", "一行\n两行", "trailing\\"];
    assert.deepEqual(command(shim, args), [process.execPath, entry, ...args]);
    writeFileSync(shim, "@ECHO OFF\r\necho arbitrary %*\r\n");
    assert.throws(() => command(shim, args), /node/);
    writeFileSync(shim, 'rem node "%~dp0\\wrong.cjs" %*\r\n@node "%~dp0\\entry.cjs" %*\r\n');
    assert.deepEqual(command(shim, args), [process.execPath, entry, ...args]);
    writeFileSync(shim, 'rem node "%~dp0\\wrong.cjs" %*\r\necho no-node\r\n');
    assert.throws(() => command(shim, args), /node/);
  },
);
