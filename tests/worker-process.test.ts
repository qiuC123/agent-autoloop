// Failure modes: a long-lived channel child inherits synchronous worker pipes; parent death leaves the worker or its
// native helper running; process containment kills detached agents that must survive for recovery.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { startupTrial } from "../scripts/worker-startup.ts";

const windows = { skip: process.platform !== "win32", timeout: 60_000 };
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("up starts its worker before concurrent long-lived channel children exit", windows, async () => {
  const directory = mkdtempSync(join(tmpdir(), "autoloop-handle-race-"));
  const preload = join(directory, "race.mjs");
  writeFileSync(
    preload,
    `
    import { isMainThread } from 'node:worker_threads';
    import cp from 'node:child_process';
    import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const worker = !isMainThread || process.argv[1]?.replaceAll('\\\\', '/').endsWith('/worker/process.ts');
    if (worker) {
      const original = cp.execFileSync;
      cp.execFileSync = (...args) => {
        if (String(args[0]).endsWith('acl.exe'))
          for (let n = 0; n < 4; n++) original(process.execPath, ['-e', ''], {windowsHide:true,timeout:5_000});
        return original(...args);
      };
      syncBuiltinESMExports();
    } else {
      const home = process.env.AGENT_AUTOLOOP_HOME;
      const plugin = join(home, 'plugins', 'consumer');
      mkdirSync(plugin, {recursive:true});
      writeFileSync(join(plugin, 'channel.ts'), ${JSON.stringify(`
        import { spawn } from 'node:child_process';
        export default async function({signal, log}) {
          const children = [];
          for (let n = 0; n < 32; n++) {
            children.push(spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], {windowsHide:true,stdio:'ignore'}));
            if (n === 0) log('consumers started');
          }
          const stop = () => { for (const child of children) child.kill('SIGKILL'); };
          const timer = setTimeout(() => { log('consumers released'); stop(); }, 6000);
          await new Promise(resolve => signal.addEventListener('abort', resolve, {once:true}));
          clearTimeout(timer); stop();
        }
      `)});
      const file = join(home, 'config.json');
      const config = JSON.parse(readFileSync(file, 'utf8'));
      config.channels = {consumer:{key:'fixture'}};
      writeFileSync(file, JSON.stringify(config));
    }
  `,
  );
  try {
    for (let trial = 0; trial < 3; trial++) {
      const [result] = await startupTrial(0, pathToFileURL(preload).href, true, 11_000);
      const started = result.output.indexOf("worker test started");
      const consuming = result.output.indexOf("consumers started");
      const released = result.output.indexOf("consumers released");
      assert.ok(result.responsive && result.online, JSON.stringify(result));
      assert.ok(consuming >= 0 && started >= 0, JSON.stringify(result));
      assert.ok(
        released < 0 || released > started,
        `worker waited for unrelated consumers to exit: ${JSON.stringify(result)}`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const ending of ["kill", "exit"]) {
  test(`up ${ending} reaps a blocked worker and native helper but preserves a detached agent`, windows, async () => {
    const directory = mkdtempSync(join(tmpdir(), "autoloop-worker-lifetime-"));
    const preload = join(directory, "lifetime.mjs");
    const ids = Object.fromEntries(["up", "worker", "native", "agent"].map((name) => [name, join(directory, name)]));
    writeFileSync(
      preload,
      `
      import { isMainThread } from 'node:worker_threads';
      import { execFileSync, spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const ids = ${JSON.stringify(ids)};
      const worker = !isMainThread || process.argv[1]?.replaceAll('\\\\', '/').endsWith('/worker/process.ts');
      if (!worker) {
        writeFileSync(ids.up, String(process.pid));
        if (${JSON.stringify(ending)} === 'exit') setTimeout(() => process.exit(0), 4000);
      } else {
        writeFileSync(ids.worker, String(process.pid));
        const agent = spawn(process.execPath, ['-e','setInterval(()=>{},1e9)'], {windowsHide:true,detached:true,stdio:'ignore'});
        agent.unref(); writeFileSync(ids.agent, String(agent.pid));
        execFileSync(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(ids.native)}, String(process.pid)); setInterval(()=>{},1e9);`)}], {windowsHide:true,timeout:60_000});
      }
    `,
    );
    try {
      const [result] = await startupTrial(0, pathToFileURL(preload).href, true, 6000);
      assert.ok(result.responsive, JSON.stringify(result));
      assert.equal(result.exitCode, ending === "exit" ? 0 : null, JSON.stringify(result));
      for (const file of Object.values(ids)) assert.ok(existsSync(file), file);
      const pid = (name: string) => Number(readFileSync(ids[name], "utf8"));
      assert.notEqual(pid("worker"), pid("up"), "worker must own a separate process handle table");
      for (let i = 0; i < 100 && (alive(pid("worker")) || alive(pid("native"))); i++) await delay(20);
      assert.equal(alive(pid("worker")), false, "blocked worker survived up");
      assert.equal(alive(pid("native")), false, "native helper survived its worker");
      assert.equal(alive(pid("agent")), true, "detached agent must remain recoverable");
    } finally {
      for (const file of Object.values(ids)) {
        if (existsSync(file)) {
          try {
            process.kill(Number(readFileSync(file, "utf8")), "SIGKILL");
          } catch {}
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
