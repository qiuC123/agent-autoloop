// Failure modes: measuring buffered writes as durable; excluding process startup; counting serial polls as concurrent.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { observePolls, checkPolls, observe, checkBudget, dispatchLatency } from "./metrics.ts";

if (process.argv.includes("--server")) {
  // A cron tick can claim the poll before its measured event and leave readiness waiting forever.
  const fixture = JSON.parse(readFileSync(new URL("../tests/rules.fixture.json", import.meta.url), "utf8"));
  fixture.rules = fixture.rules.filter((rule: { when: { cron?: string } }) => !rule.when.cron);
  fixture.elsewhere = [];
  process.env.AGENT_AUTOLOOP_RULES = join(process.env.AGENT_AUTOLOOP_HOME!, "rules.json");
  writeFileSync(process.env.AGENT_AUTOLOOP_RULES, JSON.stringify(fixture));
  const { serve } = await import("../host/http.ts");
  const { keepKeyHash } = await import("../host/runtime.ts");
  const { db } = await import("../host/runtime.ts");
  const { createHash } = await import("node:crypto");
  for (const [kind, name] of [
    ["source", "app"],
    ["worker", "w1"],
  ] as const)
    keepKeyHash(kind, name, createHash("sha256").update(kind).digest("hex"));
  db.exec("PRAGMA synchronous = FULL");
  const server = serve(0);
  const polls = observePolls(server);
  await once(server, "listening");
  console.log(
    JSON.stringify({
      port: (server.address() as { port: number }).port,
      rssMB: process.memoryUsage().rss / 1e6,
      sqlite: db.prepare("PRAGMA synchronous").get(),
    }),
  );
  process.on("message", () =>
    server.getConnections((error, connections) => {
      if (error) throw error;
      process.send!({ rssMB: process.memoryUsage().rss / 1e6, connections, ...polls });
    }),
  );
  process.on("SIGTERM", () => {
    server.closeAllConnections();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
} else {
  const { spawn } = await import("node:child_process");
  const home = mkdtempSync(join(tmpdir(), "agent-autoloop-bench-"));
  const start = performance.now();
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", import.meta.filename, "--server"], {
    env: {
      ...process.env,
      AGENT_AUTOLOOP_HOME: home,
      AGENT_AUTOLOOP_RULES: join(import.meta.dirname, "../tests/rules.fixture.json"),
    },
    stdio: ["ignore", "pipe", "inherit", "ipc"],
  });
  try {
    const ready = JSON.parse(String((await once(child.stdout!, "data"))[0]));
    const coldMs = performance.now() - start;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    child.send("sample");
    const [idle] = await once(child, "message");
    const url = `http://127.0.0.1:${ready.port}`;
    const request = async (path: string, key: string, body?: unknown) => {
      const res = await fetch(url + path, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(res.status, 200);
      return res.json();
    };
    const count = Number(process.env.BENCH_EVENTS ?? 1000);
    const writeAt = performance.now();
    for (let i = 0; i < count; i++) await request("/v1/events", "source", { id: `write:${i}`, type: "unrouted" });
    const durableEventsPerSecond = (count * 1000) / (performance.now() - writeAt);
    const latency = [];
    for (let i = 0; i < 100; i++) {
      const { job, ms } = await dispatchLatency(
        request,
        async () => {
          for (;;) {
            child.send("sample");
            const [sample] = await once(child, "message");
            if (sample.active === 1) break;
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        },
        i,
      );
      latency.push(ms);
      await request(`/v1/runs/${job.run}/result`, job.token, { outcome: "done" });
    }
    const polls = [];
    for (let i = 0; i < 1000; i++) {
      polls.push(observe(request(`/v1/work?wait=5&capacity=0&claim=p${i}`, "worker")));
      if (i % 32 === 31) {
        if (process.platform === "win32") {
          // Let Windows accept this batch before filling its pending connection queue again.
          const deadline = performance.now() + 4000;
          for (;;) {
            child.send("sample");
            const [sample] = await once(child, "message");
            if (sample.active === i + 1) break;
            assert.ok(performance.now() < deadline, "等待中的连接没有达到本批数量");
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        } else await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.send("sample");
    const [loaded] = await once(child, "message");
    const responses = (await Promise.all(polls)).map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    assert.ok(responses.every((r) => r.job === null));
    checkPolls(loaded, responses.length);
    const simulation = (await import("../sim/random.ts")).simulate();
    const kernelFolder = join(import.meta.dirname, "../kernel");
    const kernelLines = readdirSync(kernelFolder)
      .filter((file) => file.endsWith(".ts"))
      .reduce((total, file) => total + readFileSync(join(kernelFolder, file), "utf8").trimEnd().split("\n").length, 0);
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const measured = {
      kernelLines,
      runtimeDependencies: Object.keys(manifest.dependencies ?? {}).length,
      machine: cpus()[0].model,
      node: process.version,
      coldMs,
      idleRssMB: idle.rssMB,
      loadedRssMB: loaded.rssMB,
      synchronous: ready.sqlite,
      events: count,
      durableEventsPerSecond,
      eventToClaimP99Ms: latency.sort((a, b) => a - b)[98],
      concurrentPolls: loaded.active,
      completedPolls: responses.length,
      connectionsAtPeak: loaded.connections,
      simulation,
      simulationStepsPerSecond: simulation.stepsPerSecond,
    };
    console.log(JSON.stringify(measured, null, 2));
    if (process.argv.includes("--check")) checkBudget(measured);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    rmSync(home, { recursive: true, force: true });
  }
}
