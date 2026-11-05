// Reproduce an embedded worker that leaves a responsive hub without a worker. All state is disposable.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const cli = new URL("../bin/agent-autoloop.ts", import.meta.url);

export async function startupTrial(restarts = 1, preload?: string, untilExit = false, observeMs = 30_000) {
  const home = mkdtempSync(join(tmpdir(), "autoloop-worker-startup-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(AGENT_AUTOLOOP_|NODE_OPTIONS$|NODE_TEST_CONTEXT$)/.test(key)),
  );
  env.AGENT_AUTOLOOP_HOME = home;
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`;
  writeFileSync(
    join(home, "rules.json"),
    JSON.stringify({
      sources: {},
      channels: {},
      agents: { test: { name: "test", worker: "test", use: "command", command: [process.execPath] } },
      rules: [],
    }),
  );
  const launch = (args: string[]) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ...args], {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { child, closed, output: () => output };
  };
  try {
    const setup = launch([
      "--input-type=module",
      "-e",
      `
      import { addKey, db } from ${JSON.stringify(new URL("../host/runtime.ts", import.meta.url).href)};
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(home, "config.json"))}, JSON.stringify({url:${JSON.stringify(url)},hub:{listen:'127.0.0.1:${port}'},worker:{name:'test',key:addKey('worker','test')},owner:addKey('owner','test')}));
      db.close();`,
    ]);
    assert.equal(await setup.closed, 0, setup.output());
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    const results = [];
    for (let restart = 0; restart <= restarts; restart++) {
      const up = launch([...(preload ? ["--import", preload] : []), fileURLToPath(cli), "up"]);
      let responsive = false;
      let online = false;
      const started = Date.now();
      try {
        while (Date.now() - started < observeMs && up.child.exitCode === null && up.child.signalCode === null) {
          try {
            const response = await fetch(`${url}/v1/state`, {
              headers: { authorization: `Bearer ${config.owner}` },
              signal: AbortSignal.timeout(1000),
            });
            if (response.ok) {
              responsive = true;
              const state = await response.json();
              // A restart must make a fresh request, not reuse the previous online projection.
              online =
                state.agents.some(
                  (agent: { online: boolean; seenAt: string }) => agent.online && Date.parse(agent.seenAt) >= started,
                ) && up.output().includes("worker test started");
              if (online && !untilExit) break;
            }
          } catch {}
          await delay(100);
        }
        results.push({
          restart,
          responsive,
          online,
          exitCode: up.child.exitCode,
          ms: Date.now() - started,
          output: up.output(),
        });
      } finally {
        up.child.kill("SIGKILL");
        await up.closed;
      }
    }
    return results;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const count = Number(process.argv[2] ?? 12);
  const parallel = Number(process.argv[3] ?? 3);
  assert.ok(Number.isInteger(count) && count > 0 && Number.isInteger(parallel) && parallel > 0);
  const results = [];
  for (let i = 0; i < count; i += parallel) {
    const batch = await Promise.all(Array.from({ length: Math.min(parallel, count - i) }, () => startupTrial()));
    for (const trials of batch)
      for (const trial of trials) {
        results.push(trial);
        console.log(JSON.stringify(trial));
      }
  }
  const stalled = results.filter((result) => result.responsive && !result.online).length;
  console.log(
    JSON.stringify({
      node: process.version,
      platform: process.platform,
      attempts: results.length,
      stalled,
      rate: stalled / results.length,
    }),
  );
  process.exitCode = results.some((result) => !result.online) ? 1 : 0;
}
