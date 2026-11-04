// Prevents shipping an unparseable installer or one that changes global PATH, installs packages, or overwrites another command.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const installer = path.join(import.meta.dirname, "..", "install.ps1");
test("PowerShell installer is parseable without executing it", { skip: process.platform !== "win32" }, () => {
  const file = Buffer.from(installer).toString("base64");
  const script = `$errors=$null;$tokens=$null;[void][Management.Automation.Language.Parser]::ParseFile([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${file}')),[ref]$tokens,[ref]$errors);if($errors.Count){$errors|Out-String|Write-Error;exit 1}`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("PowerShell installer preserves data and delegates to the same init and service entry points", () => {
  const source = readFileSync(installer, "utf8");
  assert.match(source, /AGENT_AUTOLOOP_REPO/);
  assert.match(source, /AGENT_AUTOLOOP_HOME/);
  assert.match(source, /pull --ff-only --quiet/);
  assert.match(source, /clone --quiet --depth 1 --/);
  assert.match(source, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(source, /ReadAllText\(\$target\) -ne \$launcher/);
  assert.match(source, /config\.json/);
  assert.match(source, /--no-service/);
  assert.match(source, /\$program init @initArgs/);
  assert.match(source, /\$program service install/);
  assert.doesNotMatch(source, /SetOwner|SetEnvironmentVariable|npm (?:install|i|link)|Set-ExecutionPolicy|Remove-Item/);
});
