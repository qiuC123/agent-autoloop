// Failure modes: Windows shell parsing changes arguments; restart loses a live turn; cancellation or an externally
// killed wrapper leaves descendants running; recovery releases a starting turn before its guardian starts business.
// All processes are local Node fixtures, with no real agent or channel.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("windows-worker");
const folder = join(home, "project ' 中文");
mkdirSync(folder);
const { createWorker } = await import("../worker/worker.ts");
let next = 0;
const windows = { skip: process.platform !== "win32" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tree = (ids: string) => `const fs = require('node:fs'); const cp = require('node:child_process');
  const depth = Number(process.argv[2] || 0);
  fs.appendFileSync(${JSON.stringify(ids)}, process.pid + '\\n');
  if (depth < 2) cp.spawn(process.execPath, [__filename, String(depth + 1)], { detached: true, stdio: 'ignore' }).unref();
  process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(done: () => boolean, tick = async () => {}, seconds = 20) {
  const end = Date.now() + seconds * 1000;
  while (!done()) {
    assert.ok(Date.now() < end, "timed out waiting for the process fixture");
    await tick();
    await sleep(30);
  }
}

function fixture(source: string, args: string[] = []) {
  const run = ++next;
  const script = join(folder, `agent-${run}.cjs`);
  writeFileSync(script, source);
  const results: any[] = [];
  const cancels: number[] = [];
  let claimed = false;
  const job = {
    run,
    attempt: 1,
    token: `token-${run}`,
    session: null,
    askFirst: [],
    rule: { name: "Windows", cwd: folder, prompt: "trusted" },
    agent: { id: "local", name: "Node", use: "command", access: "read", command: [process.execPath, script, ...args] },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
  const hub: any = {
    work: async () => {
      const nextJob = claimed ? null : job;
      claimed = true;
      return { job: nextJob, cancel: cancels.splice(0) };
    },
    started: async () => ({}),
    result: async (_run: number, _token: string, body: unknown) => {
      results.push(body);
      return {};
    },
  };
  return { run, job, results, cancels, worker: () => createWorker({ name: "windows-test", wait: 0, hub }) };
}

test("Windows inherits terminal login environment and preserves every literal argument", windows, async () => {
  process.env.AGENT_AUTOLOOP_SECRET_TEST = "not-for-agent";
  const args = ["", "a b", 'quote"and\\', "尾部\\", "$(echo injected); & | %PATH% 中文", ""];
  const output = join(folder, "environment.json");
  const f = fixture(
    `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({ args: process.argv.slice(2), path: process.env.PATH,
    user: process.env.USERPROFILE, secret: process.env.AGENT_AUTOLOOP_SECRET_TEST })); console.log('完成');`,
    args,
  );
  const worker = f.worker();
  await until(
    () => f.results.length === 1,
    () => worker.tick().then(() => {}),
  );
  const result = JSON.parse(readFileSync(output, "utf8"));
  assert.deepEqual(result.args, args);
  assert.equal(result.path, process.env.PATH);
  assert.equal(result.user, process.env.USERPROFILE);
  assert.equal(result.secret, undefined);
});

test("Windows reclaims a live turn after worker restart and recovers its exit", windows, async () => {
  const ready = join(folder, "reclaimed");
  const f = fixture(`require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');
    setTimeout(() => console.log('重启后完成'), 1000);`);
  await f.worker().tick();
  await until(() => existsSync(ready));
  const worker = f.worker();
  await worker.tick();
  assert.equal(f.results.length, 0);
  assert.equal(worker.entries().length, 1);
  await until(
    () => f.results.length === 1,
    () => worker.tick().then(() => {}),
  );
  assert.equal(f.results[0].summary, "重启后完成");
});

test("Windows guardian survives an externally killed worker process and a new worker cancels it", windows, async () => {
  const ready = join(folder, "worker-process-ready");
  const f = fixture(tree(ready));
  const harness = join(folder, "worker-host.mjs");
  writeFileSync(
    harness,
    `import { createWorker } from ${JSON.stringify(new URL("../worker/worker.ts", import.meta.url).href)};
    let once = false; const worker = createWorker({ name: 'old-worker', wait: 0, hub: {
      work: async () => { const job = once ? null : ${JSON.stringify(f.job)}; once = true; return { job, cancel: [] }; },
      started: async () => ({}), result: async () => ({})
    }}); await worker.tick(); setInterval(() => {}, 1000);`,
  );
  const host = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", harness], {
    stdio: "ignore",
    windowsHide: true,
  });
  await until(() => existsSync(ready) && readFileSync(ready, "utf8").trim().split("\n").length === 3);
  const pids = readFileSync(ready, "utf8").trim().split("\n").map(Number);
  try {
    const exited = new Promise((resolve) => host.once("exit", resolve));
    host.kill("SIGKILL");
    await exited;
    assert.deepEqual(pids.map(alive), [true, true, true]);
    const results: any[] = [];
    const worker = createWorker({
      name: "new-worker",
      wait: 0,
      hub: {
        work: async () => ({ job: null, cancel: [f.run] }),
        started: async () => ({}),
        result: async (_run: number, _token: string, body: any) => {
          results.push(body);
          return {};
        },
      } as any,
    });
    await until(
      () => results.length === 1,
      () => worker.tick().then(() => {}),
    );
    assert.equal(results[0].outcome, "cancelled");
    assert.deepEqual(pids.map(alive), [false, false, false]);
  } finally {
    host.kill("SIGKILL");
    for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
  }
});

for (const external of [false, true]) {
  test(
    `Windows ${external ? "external wrapper kill" : "cancellation after restart"} stops every generation`,
    windows,
    async () => {
      const ids = join(folder, `tree-${external}.jsonl`);
      const f = fixture(tree(ids));
      const worker = f.worker();
      await worker.tick();
      await until(() => existsSync(ids) && readFileSync(ids, "utf8").trim().split("\n").length === 3);
      const entry = worker.entries()[0];
      const pids = readFileSync(ids, "utf8").trim().split("\n").map(Number);
      try {
        if (external) process.kill(entry.pid!, "SIGKILL");
        else f.cancels.push(f.run);
        const again = f.worker();
        await until(
          () => f.results.length === 1,
          () => again.tick().then(() => {}),
        );
        await until(() => pids.every((pid) => !alive(pid)));
        assert.deepEqual(pids.map(alive), [false, false, false]);
        assert.equal(f.results[0].outcome, external ? "failed" : "cancelled");
      } finally {
        for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
      }
    },
  );
}

for (const phase of ["before-lease", "before-job", "after-job"]) {
  test(`Windows recovery owns the ${phase} startup window before releasing its turn`, windows, async () => {
    const gate = join(home, `startup-${phase}`);
    const release = `${gate}.release`;
    const business = `${gate}.business`;
    const f = fixture(
      `require('node:fs').writeFileSync(${JSON.stringify(business)}, String(process.pid)); setInterval(() => {}, 1000)`,
    );
    const dir = join(home, "worker", "runs", `${f.run}-1`);
    mkdirSync(dir, { recursive: true });
    const name = `Local\\agent-autoloop-startup-${process.pid}-${f.run}`;
    writeFileSync(
      join(dir, "entry.json"),
      JSON.stringify({
        run: f.run,
        token: f.job.token,
        attempt: 1,
        job: f.job,
        dir,
        prompt: "trusted",
        turn: 1,
        session: "startup",
        resume: null,
        repairs: 0,
        triedFresh: false,
        windowsJob: name,
        launchedAt: Date.now(),
      }),
    );
    const exit = join(dir, "exit-1");
    const spec = `${exit}.launch`;
    writeFileSync(
      spec,
      [folder, join(dir, "stdout-1.log"), join(dir, "stderr-1.log"), exit, `${exit}.ready`, ...f.job.agent.command]
        .map((value) => Buffer.from(value).toString("base64"))
        .join("\n") + "\n",
    );
    const pause = `System.IO.File.WriteAllText(${JSON.stringify(gate)}, "paused"); while (!System.IO.File.Exists(${JSON.stringify(release)})) Thread.Sleep(10);`;
    const source = readFileSync(new URL("../worker/windows-job.cs", import.meta.url), "utf8");
    const anchor =
      phase !== "before-lease"
        ? "job = CreateJobObject(IntPtr.Zero, name);"
        : 'if (args[0] == "run") return Run(args[1], args[2]);';
    assert.ok(source.includes(anchor), "the fault-injection point must still be the real startup boundary");
    const injected =
      phase === "after-job"
        ? `${anchor} ${pause}`
        : phase === "before-job"
          ? `${pause} ${anchor}`
          : `if (args[0] == "run") { ${pause} return Run(args[1], args[2]); }`;
    const cs = `${gate}.cs`;
    const executable = `${gate}.exe`;
    writeFileSync(cs, source.replace(anchor, injected));
    const compiler = ["Framework64", "Framework"]
      .map((framework) =>
        join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", framework, "v4.0.30319", "csc.exe"),
      )
      .find(existsSync)!;
    execFileSync(compiler, ["/nologo", "/target:exe", `/out:${executable}`, cs], { windowsHide: true });
    const guardian = spawn(executable, ["run", name, spec], { windowsHide: true, stdio: "ignore" });
    let ended = false;
    guardian.on("exit", () => {
      ended = true;
    });
    const results: any[] = [];
    let cancel = false;
    const worker = createWorker({
      name: "startup-recovery",
      wait: 0,
      hub: {
        work: async () => ({ job: null, cancel: cancel ? [f.run] : [] }),
        started: async () => ({}),
        result: async (_run: number, _token: string, result: any) => {
          results.push(result);
          return {};
        },
      } as any,
    });
    try {
      await until(() => existsSync(gate));
      await worker.tick();
      if (phase !== "before-lease") {
        assert.equal(results.length, 0, "a guardian that owns startup must keep its turn");
        assert.equal(worker.entries().length, 1);
        cancel = true;
        await worker.tick();
        assert.equal(results.length, 0, "an empty starting job is not yet confirmed stopped");
        writeFileSync(release, "resume");
        await until(
          () => results.length === 1,
          () => worker.tick().then(() => {}),
        );
        assert.equal(results[0].outcome, "cancelled");
      } else {
        assert.equal(results[0]?.outcome, "failed");
        assert.equal(worker.entries().length, 0);
        writeFileSync(release, "resume");
        await until(() => ended || existsSync(business));
        assert.equal(existsSync(business), false, "a revoked startup must never run late business");
      }
    } finally {
      writeFileSync(release, "resume");
      if (!ended) guardian.kill("SIGKILL");
      await until(() => ended);
      if (existsSync(business)) {
        const pid = Number(readFileSync(business, "utf8"));
        if (alive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });
}
