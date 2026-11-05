// Failure modes: startup or work stalls silently; native blocking prevents exit; healthy progress is killed;
// a clean worker exit or an uncaught exception leaves the hub running without a worker.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startupTrial } from "../scripts/worker-startup.ts";

test(
  "embedded worker starts after a fresh setup and an immediate hard restart",
  { skip: process.platform !== "win32", timeout: 150_000 },
  async () => {
    const results = (await Promise.all([startupTrial(), startupTrial()])).flat();
    assert.ok(
      results.every((result) => result.online),
      JSON.stringify(results),
    );
  },
);

for (const fault of ["loading", "preparation", "native", "poll", "healthy", "retry", "exit", "error"]) {
  test(`embedded worker supervision: ${fault}`, { skip: process.platform !== "win32", timeout: 45_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "autoloop-worker-fault-"));
    const preload = join(directory, "fault.mjs");
    const nativePid = join(directory, "native.pid");
    writeFileSync(
      preload,
      `
      import cp from 'node:child_process';
      import { registerHooks, syncBuiltinESMExports } from 'node:module';
      const fault = ${JSON.stringify(fault)};
      if (!process.argv[1]?.replaceAll('\\\\', '/').endsWith('/worker/process.ts')) {
        const original = globalThis.setTimeout;
        globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 30000 || ms === 120000 ? 5000 : ms, ...args);
      } else {
        if (fault === 'loading') registerHooks({ load(url, context, next) {
          if (url.endsWith('/worker/process.ts')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          return next(url, context);
        }});
        if (fault === 'preparation') {
          cp.execFileSync = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          syncBuiltinESMExports();
        }
        if (fault === 'native') {
          const original = cp.execFileSync;
          cp.execFileSync = () => original(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(nativePid)}, String(process.pid)); setTimeout(() => {}, 20000);`)}], {windowsHide: true, timeout:30_000});
          syncBuiltinESMExports();
        }
        if (fault === 'poll' || fault === 'healthy') {
          setInterval(() => {}, 1000);
          const original = globalThis.fetch;
          let polled = false;
          globalThis.fetch = (url, options) => {
            if (String(url).includes('/v1/work?')) {
              if (polled && fault === 'poll') return new Promise(() => {});
              polled = true;
              url = String(url).replace('wait=50', 'wait=1');
            }
            return original(url, options);
          };
        }
        if (fault === 'retry') {
          const original = globalThis.setTimeout;
          globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 30000 ? 1000 : ms, ...args);
          globalThis.fetch = async () => { throw new Error('synthetic unreachable hub'); };
        }
        if (fault === 'exit') process.exit(0);
        if (fault === 'error') throw new Error('synthetic worker failure');
      }
    `,
    );
    try {
      const [result] = await startupTrial(
        0,
        pathToFileURL(preload).href,
        true,
        fault === "healthy" || fault === "retry" ? 13_000 : 30_000,
      );
      if (fault !== "exit" && fault !== "error") assert.equal(result.responsive, true, JSON.stringify(result));
      if (fault === "poll" || fault === "healthy") assert.equal(result.online, true, JSON.stringify(result));
      if (fault === "healthy" || fault === "retry") {
        assert.equal(result.exitCode, null, JSON.stringify(result));
        if (fault === "retry") assert.match(result.output, /synthetic unreachable hub/);
        return;
      }
      assert.notEqual(result.exitCode, null, `up silently stayed alive: ${JSON.stringify(result)}`);
      assert.notEqual(result.exitCode, 0, JSON.stringify(result));
      if (fault === "native") assert.ok(result.ms < 15_000, "exit must not wait for a synchronous native child");
      assert.match(
        result.output,
        fault === "error"
          ? /synthetic worker failure/
          : fault === "exit"
            ? /接单进程退出/
            : /接单进程.*(启动|心跳).*超时/,
      );
    } finally {
      if (existsSync(nativePid)) {
        try {
          process.kill(Number(readFileSync(nativePid, "utf8")), "SIGKILL");
        } catch {}
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
