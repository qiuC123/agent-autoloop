// Prevents registering a machine-wide task, losing the terminal PATH, executing quoted paths as code, or removing another task.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { windowsService } from "../host/windows-service.ts";

const directory = mkdtempSync(path.join(tmpdir(), "agent-autoloop-service-"));
after(() => rmSync(directory, { recursive: true, force: true }));

test("Windows task uses the current user's interactive login, one instance and no execution time limit", () => {
  const calls: [string, string[]][] = [];
  const service = windowsService({
    home: path.join(directory, "home & space"),
    node: "C:\\Program Files\\nodejs\\node.exe",
    program: "C:\\a & b\\agent-autoloop.ts",
    runner: "C:\\a & b\\windows-service.ts",
    searchPath: "C:\\my tools;C:\\Windows\\System32",
    user: "S-1-5-21-123",
    run: (program, args) => {
      calls.push([program, args]);
      return { status: program === "powershell.exe" ? 1 : 0, stdout: "" };
    },
  });
  service.install();
  assert.deepEqual(calls, [
    service.queryCommand,
    ["schtasks.exe", ["/Create", "/TN", service.name, "/XML", service.taskFile, "/F"]],
    ["schtasks.exe", ["/Run", "/TN", service.name]],
  ]);
  assert.deepEqual(service.queryCommand[1].slice(0, 4), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
  ]);
  const query = Buffer.from(service.queryCommand[1][4], "base64").toString("utf16le");
  assert.match(query, /Schedule\.Service/);
  assert.match(query, /GetTask\(\$n\)\.Xml/);
  assert.ok(query.includes(Buffer.from(service.name).toString("base64")));
  assert.match(query, /ToBase64String\(\[Text.Encoding\]::UTF8.GetBytes/);
  assert.doesNotMatch(query, /OutputEncoding|Register|Delete|Run\(/);
  const xml = readFileSync(service.taskFile, "utf16le");
  assert.match(xml, /<UserId>S-1-5-21-123<\/UserId>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<AllowHardTerminate>false<\/AllowHardTerminate>/);
  assert.match(xml, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>999<\/Count>/);
  assert.match(xml, /<Command>C:\\Program Files\\nodejs\\node.exe<\/Command>/);
  assert.match(xml, /&amp;/);
  const config = JSON.parse(readFileSync(service.configFile, "utf8"));
  assert.equal(config.searchPath, "C:\\my tools;C:\\Windows\\System32");
  assert.equal(config.home, path.join(directory, "home & space"));
  assert.ok(!Object.hasOwn(config, "environment"), "do not persist unrelated terminal secrets");
});

test("Windows remove only deletes the matching task and leaves another task untouched", () => {
  const calls: string[][] = [];
  let registered = "<Task>another program</Task>";
  const service = windowsService({
    home: path.join(directory, "remove"),
    user: "S-1-5-21-123",
    run: (_program, args) => {
      calls.push(args);
      return { status: 0, stdout: Buffer.from(registered).toString("base64") };
    },
  });
  mkdirSync(path.dirname(service.taskFile), { recursive: true });
  writeFileSync(service.taskFile, "local ownership alone is insufficient");
  assert.throws(() => service.install(), /同名/);
  service.remove();
  assert.ok(calls.every((args) => args[0] === "-NoLogo"));
  registered = service.xml();
  service.remove();
  assert.deepEqual(calls.at(-1), ["/Delete", "/TN", service.name, "/F"]);
  assert.ok(!calls.some((args) => args[0] === "/End"), "normal service stop must preserve detached agents");
});

test("Windows service names distinguish data directories, and launcher arguments are literal", () => {
  const first = windowsService({ home: path.join(directory, 'quote " & $()'), user: "S-1-5-21-123" });
  const second = windowsService({ home: path.join(directory, "second"), user: "S-1-5-21-123" });
  assert.notEqual(first.name, second.name);
  const xml = first.xml();
  assert.match(xml, /<Arguments>.*&quot;.*<\/Arguments>/);
  assert.doesNotMatch(xml, /cmd\.exe|powershell|ExecutionPolicy|<Password>/);
});

test("Windows task ownership checks the actual executable, full arguments, directory and user", () => {
  for (const [name, replace] of [
    ["command", (xml: string) => xml.replace(/<Command>[^<]*<\/Command>/, "<Command>C:\\other.exe</Command>")],
    ["arguments", (xml: string) => xml.replace("--disable-warning=ExperimentalWarning", "--eval runOtherCode")],
    [
      "directory",
      (xml: string) =>
        xml.replace(/<WorkingDirectory>[^<]*<\/WorkingDirectory>/, "<WorkingDirectory>C:\\other</WorkingDirectory>"),
    ],
    [
      "principal",
      (xml: string) =>
        xml.replace(
          /<Principals>[\s\S]*?<\/Principals>/,
          '<Principals><Principal id="Owner"><UserId>S-1-5-18</UserId></Principal></Principals>',
        ),
    ],
    [
      "extra action",
      (xml: string) => xml.replace("</Actions>", "<Exec><Command>C:\\other.exe</Command></Exec></Actions>"),
    ],
  ] as const) {
    const calls: string[][] = [];
    let registered = "";
    const service = windowsService({
      home: path.join(directory, `ownership-${name}`),
      user: "S-1-5-21-123",
      run: (_program, args) => {
        calls.push(args);
        return { status: 0, stdout: Buffer.from(registered).toString("base64") };
      },
    });
    mkdirSync(path.dirname(service.taskFile), { recursive: true });
    writeFileSync(service.taskFile, "local file does not establish task ownership");
    registered = replace(service.xml());
    assert.throws(() => service.install(), /同名/, name);
    service.remove();
    assert.ok(!calls.some((args) => ["/Delete", "/Create", "/Run"].includes(args[0])), name);
  }
});

test("Windows task readback preserves Unicode paths and accepts standard XML entity serialization", () => {
  let registered = "";
  const calls: string[][] = [];
  const service = windowsService({
    home: path.join(directory, "readback 中文 & space"),
    node: "C:\\工具\\node.exe",
    program: "C:\\演示 & space\\agent-autoloop.ts",
    runner: "C:\\工具\\windows-service.ts",
    user: "S-1-5-21-123",
    run: (_program, args) => {
      calls.push(args);
      return { status: 0, stdout: Buffer.from(registered).toString("base64") };
    },
  });
  mkdirSync(path.dirname(service.taskFile), { recursive: true });
  writeFileSync(service.taskFile, "fixture");
  registered = service.xml().replaceAll("&quot;", '"').replace("演", "&#x6f14;");
  service.remove();
  assert.deepEqual(calls.at(-1), ["/Delete", "/TN", service.name, "/F"]);
});

test("Windows task launcher preserves PATH and login directories, logs both streams and returns the engine status", () => {
  const target = path.join(directory, "runner target 中文 & space");
  mkdirSync(path.join(target, "logs"), { recursive: true });
  const home = path.join(directory, "runner 中文 & space");
  symlinkSync(target, home, process.platform === "win32" ? "junction" : "dir");
  const program = path.join(home, "engine.mjs");
  writeFileSync(
    program,
    `console.log(JSON.stringify({path:process.env.PATH,codex:process.env.CODEX_HOME,home:process.env.AGENT_AUTOLOOP_HOME,cwd:process.cwd()}));console.error('engine error');process.exitCode=7;`,
  );
  const configuration = path.join(home, "service.json");
  writeFileSync(
    configuration,
    JSON.stringify({
      home,
      node: process.execPath,
      program,
      searchPath: "test path only",
      agentHomes: { CODEX_HOME: "test login directory" },
    }),
  );
  const result = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, "..", "host", "windows-service.ts"), configuration],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 7, result.stderr);
  const lines = readFileSync(path.join(home, "logs", "up.log"), "utf8")
    .trim()
    .split(/\r?\n/);
  const { cwd, ...environment } = JSON.parse(lines[0]);
  assert.deepEqual(environment, { path: "test path only", codex: "test login directory", home });
  assert.equal(realpathSync(cwd), realpathSync(home));
  assert.ok(lines.includes("engine error"));
});
