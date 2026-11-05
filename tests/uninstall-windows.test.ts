// Prevents Windows uninstall deleting data, removing another .cmd, or trusting a recycled PID as its own engine.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { controlUp } from "../host/windows-control.ts";
import { windowsLauncher } from "../host/windows-launcher.ts";

const root = path.join(import.meta.dirname, "..");
const directory = mkdtempSync(path.join(tmpdir(), "agent-autoloop-uninstall-win-"));
const children: ChildProcess[] = [];
after(() => {
  for (const child of children) child.kill();
  rmSync(directory, { recursive: true, force: true });
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "Windows uninstall removes only its exact launcher and checkout, preserving rules, keys and other commands",
  { skip: process.platform !== "win32" },
  () => {
    const home = path.join(directory, "person 演示 & space", ".agent-autoloop");
    const app = path.join(home, "app");
    const copied = path.join(directory, "person");
    for (const part of ["bin", "cli", "host", "kernel", "plugins", "protocol", "skills", "worker", "package.json"]) {
      cpSync(path.join(root, part), path.join(copied, ".agent-autoloop", "app", part), { recursive: true });
    }
    // Node 24.14's Windows cpSync corrupts Unicode destination names; renameSync preserves them.
    renameSync(copied, path.dirname(home));
    const mine = path.join(directory, "mine");
    const theirs = path.join(directory, "theirs");
    for (const place of [mine, theirs]) mkdirSync(place);
    const program = path.join(app, "bin", "agent-autoloop.ts");
    assert.ok(existsSync(program), program);
    writeFileSync(path.join(mine, "agent-autoloop.cmd"), windowsLauncher(process.execPath, program));
    writeFileSync(path.join(theirs, "agent-autoloop.cmd"), "my own command");
    writeFileSync(path.join(home, "config.json"), "{}");
    writeFileSync(path.join(home, "master.key"), "test fixture key");
    writeFileSync(path.join(home, "rules.json"), "test fixture rules");
    const environment = {
      ...process.env,
      AGENT_AUTOLOOP_HOME: home,
      HOME: path.dirname(home),
      USERPROFILE: path.dirname(home),
      PATH: [mine, theirs, process.env.PATH].join(path.delimiter),
    };
    const launched = spawnSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", `""${path.join(mine, "agent-autoloop.cmd")}" --version"`],
      { timeout: 30_000, env: environment, encoding: "utf8", windowsVerbatimArguments: true },
    );
    assert.equal(launched.status, 0, launched.stderr);
    assert.match(launched.stdout, /agent-autoloop/);
    const denied = spawnSync(process.execPath, [program, "uninstall"], {
      timeout: 30_000,
      env: environment,
      encoding: "utf8",
    });
    assert.notEqual(denied.status, 0);
    assert.ok(existsSync(app));
    const removed = spawnSync(process.execPath, [program, "uninstall", "--yes"], {
      timeout: 30_000,
      env: environment,
      encoding: "utf8",
    });
    assert.equal(removed.status, 0, removed.stderr);
    assert.ok(!existsSync(app));
    assert.ok(!existsSync(path.join(mine, "agent-autoloop.cmd")));
    assert.equal(readFileSync(path.join(theirs, "agent-autoloop.cmd"), "utf8"), "my own command");
    assert.equal(readFileSync(path.join(home, "master.key"), "utf8"), "test fixture key");
    assert.equal(readFileSync(path.join(home, "rules.json"), "utf8"), "test fixture rules");
    assert.ok(existsSync(path.join(home, "config.json")));
  },
);

test(
  "Windows control rejects a second engine and stale identities, and stops the actual owner",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async () => {
    const home = path.join(directory, "control");
    mkdirSync(home);
    const helper = pathToFileURL(path.join(root, "host", "windows-control.ts")).href;
    const code = `const {listenForControl}=await import(${JSON.stringify(helper)});let unlock;unlock=await listenForControl(process.argv[1],()=>{unlock();process.exit(0)});console.log('ready');`;
    const launch = (dataHome = home) =>
      spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code, dataHome], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    const child = launch();
    children.push(child);
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (errors += chunk));
    for (let i = 0; i < 200 && !output.includes("ready") && child.exitCode === null; i++) await pause(50);
    assert.match(output, /ready/, errors);
    assert.equal(controlUp(home, "status"), child.pid);
    const alias = path.join(directory, "control-alias");
    symlinkSync(home, alias, "junction");
    const duplicate = launch(alias);
    children.push(duplicate);
    const duplicateCode = await new Promise((resolve) => duplicate.on("exit", resolve));
    assert.notEqual(duplicateCode, 0);
    assert.equal(controlUp(home, "status"), child.pid);
    const file = path.join(home, "up.pid");
    const identity = readFileSync(file, "utf8");
    writeFileSync(file, JSON.stringify({ pid: process.pid, token: "wrong" }));
    assert.equal(controlUp(home, "stop"), null);
    assert.equal(child.exitCode, null);
    writeFileSync(file, identity);
    const stopped = new Promise((resolve) => child.on("exit", resolve));
    const environment = { ...process.env, AGENT_AUTOLOOP_HOME: home, HOME: directory, USERPROFILE: directory };
    const status = spawnSync(process.execPath, [path.join(root, "bin", "agent-autoloop.ts"), "service", "status"], {
      timeout: 30_000,
      env: environment,
      encoding: "utf8",
    });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /没有运行/);
    const stoppedByCli = spawnSync(process.execPath, [path.join(root, "bin", "agent-autoloop.ts"), "service", "stop"], {
      timeout: 30_000,
      env: environment,
      encoding: "utf8",
    });
    assert.equal(stoppedByCli.status, 0, stoppedByCli.stderr);
    assert.equal(await stopped, 0);
    assert.equal(controlUp(home, "status"), null);
    assert.ok(!existsSync(file));
  },
);
