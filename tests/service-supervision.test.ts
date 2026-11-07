// Failure modes: a clean/crashed engine stays down, a blocked hub survives forever, stop is undone by restart,
// or a watchdog kills detached Agents instead of leaving them for recovery, including under the hidden WScript parent.
// All homes and engines are fixtures.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { controlUp } from "../host/windows-control.ts";

const runner = path.resolve(import.meta.dirname, "../host/windows-service.ts");
const launcher = path.resolve(import.meta.dirname, "../host/windows-service-launcher.js");
const wscript = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
const control = pathToFileURL(path.resolve(import.meta.dirname, "../host/windows-control.ts")).href;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check: () => boolean, detail: () => string) {
  const end = Date.now() + 15_000;
  while (!check()) {
    assert.ok(Date.now() < end, detail());
    await pause(25);
  }
}

async function fixture(
  code: string,
  run: (home: string, child: ChildProcess, log: () => string) => Promise<void>,
  consoleLauncher?: string,
) {
  const home = mkdtempSync(path.join(tmpdir(), "autoloop-service-watch-"));
  mkdirSync(path.join(home, "logs"));
  const program = path.join(home, "engine.mjs");
  const preload = path.join(home, "clock.mjs");
  // Native helper startup is not accelerated; leave it room before the shortened watchdog deadline.
  writeFileSync(
    preload,
    `import {registerHooks} from 'node:module';
    registerHooks({load(url, context, next) { const result=next(url,context);
      if(url.endsWith('/host/windows-service.ts')) result.source=String(result.source)
        .replaceAll('300_000','5000').replaceAll('wait(15_000)','wait(100)').replaceAll('60_000','800').replaceAll('1_000','100').replaceAll('delay(5_000','delay(500');
      return result; }});`,
  );
  writeFileSync(
    program,
    `import fs from 'node:fs';import {spawn,execFileSync} from 'node:child_process';
    import {listenForControl} from ${JSON.stringify(control)};
    const home=process.env.AGENT_AUTOLOOP_HOME;
    const countFile=home+'/starts';const count=Number(fs.existsSync(countFile)?fs.readFileSync(countFile,'utf8'):0)+1;
    fs.writeFileSync(countFile,String(count));console.log('start '+count+' '+process.pid);
    ${code}`,
  );
  const configuration = path.join(home, "service.json");
  writeFileSync(
    configuration,
    JSON.stringify({ home, node: process.execPath, program, searchPath: process.env.PATH, agentHomes: {} }),
  );
  const child = spawn(
    consoleLauncher ?? wscript,
    [
      ...(consoleLauncher ? [] : ["//B", "//E:JScript", launcher]),
      process.execPath,
      "--import",
      pathToFileURL(preload).href,
      runner,
      configuration,
    ],
    {
      env: { ...process.env, AGENT_AUTOLOOP_HOME: home },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let errors = "";
  let launchedPid = "";
  child.stdout!.on("data", (chunk) => (launchedPid += chunk));
  child.stderr!.on("data", (chunk) => (errors += chunk));
  const log = () =>
    (existsSync(path.join(home, "logs/up.log")) ? readFileSync(path.join(home, "logs/up.log"), "utf8") : "") + errors;
  try {
    await run(home, child, log);
  } finally {
    const runnerPid = controlUp(home, "status", "service");
    controlUp(home, "stop", "service");
    await pause(200);
    if (runnerPid && alive(runnerPid)) process.kill(runnerPid, "SIGKILL");
    if (consoleLauncher && Number(launchedPid.trim()) > 0) {
      try {
        process.kill(Number(launchedPid.trim()), "SIGKILL");
      } catch {}
    }
    if (child.exitCode === null) child.kill();
    for (const match of log().matchAll(/(?:start \d+|descendant|detached) (\d+)/g)) {
      try {
        process.kill(Number(match[1]), "SIGKILL");
      } catch {}
    }
    await pause(200);
    rmSync(home, { recursive: true, force: true });
  }
}

for (const code of [0, 7, -1073741510]) {
  test(
    `runner restarts exit ${code}, but explicit service stop stays stopped`,
    { skip: process.platform !== "win32", timeout: 25_000 },
    async () => {
      await fixture(
        `if(count===1) process.exit(${code});
      let unlock;unlock=await listenForControl(home,()=>{unlock();process.exit(0)});`,
        async (home, child, log) => {
          await until(() => log().includes("start 2"), log);
          assert.equal(child.exitCode, null, log());
          await until(() => controlUp(home, "status") !== null, log);
          const runnerPid = controlUp(home, "status", "service");
          assert.ok(runnerPid && runnerPid !== child.pid, "WScript must wait for a separate runner process");
          assert.equal(controlUp(home, "stop", "service"), runnerPid, log());
          await until(() => child.exitCode !== null, log);
          assert.equal(child.exitCode, 0, log());
          await pause(1000);
          assert.equal(readFileSync(path.join(home, "starts"), "utf8"), "2", log());
        },
      );
    },
  );
}

test(
  "watchdog reaps a blocked engine and non-detached children but preserves detached grandchildren",
  { skip: process.platform !== "win32", timeout: 25_000 },
  async () => {
    await fixture(
      `let unlock;unlock=await listenForControl(home,()=>{unlock();process.exit(0)});
    if(count===1) execFileSync(process.execPath,['-e',
      "const {spawn}=require('node:child_process');const agent=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,windowsHide:true,stdio:'ignore'});agent.unref();console.log('detached '+agent.pid);console.log('descendant '+process.pid);setInterval(()=>{},1000)"
    ],{stdio:'inherit',windowsHide:true,timeout:20_000});`,
      async (home, child, log) => {
        await until(() => log().includes("start 2"), log);
        const first = Number(/start 1 (\d+)/.exec(log())![1]);
        const descendant = Number(/descendant (\d+)/.exec(log())![1]);
        const detached = Number(/detached (\d+)/.exec(log())![1]);
        assert.equal(alive(first), false, log());
        assert.equal(alive(descendant), false, log());
        assert.equal(alive(detached), true, "detached Agent must remain available for the new worker");
        assert.equal(child.exitCode, null, log());
        await until(() => controlUp(home, "status") !== null, log);
        await pause(5500);
        assert.equal(readFileSync(path.join(home, "starts"), "utf8"), "2", "responsive engine must survive");
      },
    );
  },
);

test(
  "unhandled CTRL_BREAK produces STATUS_CONTROL_C_EXIT; the service runner survives Ctrl+C and Ctrl+Break",
  { skip: process.platform !== "win32", timeout: 35_000 },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "autoloop-console-test-"));
    const executable = path.join(directory, "console.exe");
    const compiler = ["Framework64", "Framework"]
      .map((name) => path.join(process.env.SystemRoot!, "Microsoft.NET", name, "v4.0.30319", "csc.exe"))
      .find(existsSync)!;
    execFileSync(
      compiler,
      ["/nologo", "/target:exe", `/out:${executable}`, path.join(import.meta.dirname, "windows-console.cs")],
      { windowsHide: true, timeout: 30_000, stdio: "pipe" },
    );
    let victim: ChildProcess | undefined;
    let victimPid = "";
    try {
      victim = spawn(executable, [executable, "victim"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const exited = new Promise<number | null>((resolve) => victim!.once("exit", resolve));
      victim.stdout!.on("data", (chunk) => (victimPid += chunk));
      await until(
        () => Number(victimPid.trim()) > 0,
        () => victimPid,
      );
      execFileSync(executable, ["send", victimPid.trim(), "1"], { windowsHide: true, timeout: 5_000, stdio: "pipe" });
      assert.equal((await exited)! >>> 0, 0xc000013a);
      await fixture(
        `let unlock;unlock=await listenForControl(home,()=>{unlock();process.exit(0)});`,
        async (home, child, log) => {
          await until(() => controlUp(home, "status") !== null, log);
          const pid = controlUp(home, "status", "service");
          assert.ok(pid);
          for (const signal of ["0", "1"]) {
            execFileSync(executable, ["send", String(pid), signal], {
              windowsHide: true,
              timeout: 5_000,
              stdio: "pipe",
            });
            await pause(250);
            assert.equal(child.exitCode, null, log());
            assert.equal(controlUp(home, "status", "service"), pid, log());
            await until(() => controlUp(home, "status") !== null, log);
          }
        },
        executable,
      );
    } finally {
      if (Number(victimPid.trim()) > 0) {
        try {
          process.kill(Number(victimPid.trim()), "SIGKILL");
        } catch {}
      }
      victim?.kill();
      await pause(200);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "service stop persists across repeated runner launches, even when the runner was already killed",
  { skip: process.platform !== "win32", timeout: 45_000 },
  async () => {
    for (const code of [
      "setInterval(()=>{},1000);",
      "process.exit(1);",
      "console.log('kill runner');setInterval(()=>{},1000);",
    ]) {
      await fixture(code, async (home, child, log) => {
        await until(() => log().includes("start 1"), log);
        if (code.includes("kill runner")) {
          process.kill(controlUp(home, "status", "service")!, "SIGKILL");
          await until(() => child.exitCode !== null || child.signalCode !== null, log);
        }
        execFileSync(
          process.execPath,
          [path.resolve(import.meta.dirname, "../bin/agent-autoloop.ts"), "service", "stop"],
          {
            env: { ...process.env, AGENT_AUTOLOOP_HOME: home, HOME: home, USERPROFILE: home },
            windowsHide: true,
            timeout: 15_000,
            stdio: "pipe",
          },
        );
        await until(() => child.exitCode !== null || child.signalCode !== null, log);
        const starts = readFileSync(path.join(home, "starts"), "utf8");
        await pause(1000);
        assert.equal(readFileSync(path.join(home, "starts"), "utf8"), starts);
        execFileSync(
          wscript,
          ["//B", "//E:JScript", launcher, process.execPath, runner, path.join(home, "service.json")],
          {
            env: { ...process.env, AGENT_AUTOLOOP_HOME: home },
            windowsHide: true,
            timeout: 5_000,
            stdio: "pipe",
          },
        );
        assert.equal(readFileSync(path.join(home, "starts"), "utf8"), starts, "a scheduler trigger must not undo stop");
      });
    }
  },
);

test(
  "runner backs off repeated exits and resets only after sustained health",
  { skip: process.platform !== "win32", timeout: 25_000 },
  async () => {
    await fixture(
      `if(count<5) process.exit(1);let unlock;unlock=await listenForControl(home,()=>{unlock();process.exit(0)});`,
      async (home, _child, log) => {
        await until(() => log().includes("start 5"), log);
        assert.deepEqual(
          [...log().matchAll(/将在 (\d+) 毫秒后重启/g)].map((match) => Number(match[1])),
          [100, 200, 400, 800],
        );
        await until(() => controlUp(home, "status") !== null, log);
        await pause(5500);
        assert.ok(controlUp(home, "stop"));
        await until(() => log().includes("start 6"), log);
        assert.equal([...log().matchAll(/将在 (\d+) 毫秒后重启/g)].at(-1)?.[1], "100", log());
      },
    );
  },
);
