// Failure modes: the worker grants a guessed or group identity, probes a different sandbox mode/environment, or
// a full-access launch unexpectedly changes ACLs. A cwd alias may resolve to its long or canonical path in the child.
// This uses a native fake CLI, never the installed Codex or a model.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { prepareWindows } from "../plugins/codex/windows.ts";
import { privateDirectory, writePrivateFile } from "../host/private.ts";
import { nativeCommand } from "./native-command.ts";
const root = mkdtempSync(join(tmpdir(), "agent-autoloop-codex-identity-"));
after(() => rmSync(root, { recursive: true, force: true }));

test(
  "Codex prepares the actual sandbox account using this turn's policy, cwd and login environment",
  { skip: process.platform !== "win32" },
  () => {
    const target = join(root, "working directory");
    const cwd = `${target}\\.`;
    mkdirSync(target);
    for (const access of ["read", "edit"] as const) {
      const folder = join(root, access);
      privateDirectory(folder);
      writePrivateFile(join(folder, "context.json"), "data");
      const record = join(root, `${access}.json`);
      const program = nativeCommand(
        join(root, `codex-${access}`),
        `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),home:process.env.CODEX_HOME}));console.log('S-1-5-21-1-2-3-4242');`,
      );
      const turn = {
        access,
        folder,
        cwd,
        contextFile: join(folder, "context.json"),
        prompt: "trusted",
        session: "s",
        resume: null,
      };
      const mode = access === "read" ? "read-only" : "workspace-write";
      prepareWindows(program, mode, turn, { ...process.env, CODEX_HOME: "test-login-directory" });
      const got = JSON.parse(readFileSync(record, "utf8"));
      assert.deepEqual(got.args.slice(0, 4), ["sandbox", "-c", `sandbox_mode="${mode}"`, "--"]);
      assert.equal(
        Buffer.from(got.args.at(-1), "base64").toString("utf16le"),
        "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      );
      assert.equal(realpathSync(got.cwd), realpathSync(cwd));
      assert.equal(got.home, "test-login-directory");
    }
  },
);
test("full access needs no additional sandbox grant", () => {
  prepareWindows(
    "nonexistent-program",
    "danger-full-access",
    { access: "full", folder: root, cwd: root, contextFile: "", prompt: "", session: "", resume: null },
    {},
  );
});
