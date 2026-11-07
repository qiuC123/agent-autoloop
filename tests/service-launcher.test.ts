// Failure modes: the hidden wrapper returns success before Node exits, loses an exit code, or changes literal paths.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const launcher = path.resolve(import.meta.dirname, "../host/windows-service-launcher.js");

test("JScript hides Node, waits for it and returns its exact exit code with quoted arguments", () => {
  const argv = ["C:\\Program Files\\nodejs\\node.exe", "C:\\engine & 中文\\runner.ts", "", 'a\\"b', "C:\\tail\\"];
  for (const code of [0, 3, 7]) {
    let waited = false;
    runInNewContext(readFileSync(launcher, "utf8"), {
      WScript: {
        Arguments: Object.assign((i: number) => argv[i], { Count: () => argv.length }),
        Quit: (status: number) => {
          assert.equal(waited, true);
          assert.equal(status, code);
        },
      },
      ActiveXObject: function (name: string) {
        assert.equal(name, "WScript.Shell");
        return {
          Run: (command: string, style: number, wait: boolean) => {
            assert.equal(
              command,
              '"C:\\Program Files\\nodejs\\node.exe" "C:\\engine & 中文\\runner.ts" "" "a\\\\\\"b" "C:\\tail\\\\"',
            );
            assert.equal(style, 0);
            assert.equal(wait, true);
            waited = true;
            return code;
          },
        };
      },
    });
  }
});

test(
  "real WScript waits and returns Node exit codes 0/3/7 without changing Unicode/spaced paths",
  { skip: process.platform !== "win32" },
  () => {
    const home = mkdtempSync(path.join(tmpdir(), "autoloop-hidden-中文 & "));
    try {
      const program = path.join(home, "exit code.cjs");
      const output = path.join(home, "result.json");
      writeFileSync(
        program,
        "setTimeout(() => { require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(4))); process.exit(Number(process.argv[3])); }, 100);",
      );
      for (const code of [0, 3, 7]) {
        rmSync(output, { force: true });
        const result = spawnSync(
          path.join(process.env.SystemRoot!, "System32", "wscript.exe"),
          [
            "//B",
            "//E:JScript",
            launcher,
            process.execPath,
            program,
            output,
            String(code),
            "中文 & space",
            "C:\\tail\\",
          ],
          { windowsHide: true, timeout: 10_000, encoding: "utf8" },
        );
        assert.equal(result.error, undefined);
        assert.equal(result.status, code, result.stderr);
        assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), ["中文 & space", "C:\\tail\\"]);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
