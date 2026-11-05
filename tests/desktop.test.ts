// The channel a new install starts with. Nothing real is shown here: the notify commands are stand-ins on PATH, and the one
// run of the real osascript swaps the notification for a line that only prints. Failure cases: what an Agent wrote in a card's
// title runs as AppleScript, or a title starting with a dash is read as an option (osascript runs what follows -e as script);
// an update to a card notifies again; a computer with no way to notify, a notifier that fails or a title that can't be passed
// to a program stops the channel, or isn't reported; a slow notifier freezes the hub, which shares its process; init doesn't
// set the channel up in both files, or changes a rules file already there; doctor says there's no channel when there is one,
// or that one reaches you when none does.
// Informational cards must not be announced as questions.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";
import type { Card } from "../host/channels.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-desktop-"));
const rulesFile = join(dir, "rules.json");
const rulesWith = (channels: object) => ({
  sources: { local: { name: "本机" } },
  agents: { agent: { name: "Agent", worker: "this-one", use: "command", command: ["true"] } },
  channels,
  rules: [],
});
writeFileSync(rulesFile, JSON.stringify(rulesWith({ desktop: { name: "桌面通知" } })));
const home = setup("desktop", rulesFile);
const realPath = process.env.PATH;
const realDisplay = process.env.DISPLAY;
const realWayland = process.env.WAYLAND_DISPLAY;
const realSession = process.env.SESSIONNAME;
after(() => {
  process.env.PATH = realPath;
  if (realDisplay === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = realDisplay;
  for (const [name, value] of [
    ["WAYLAND_DISPLAY", realWayland],
    ["SESSIONNAME", realSession],
  ]) {
    if (value === undefined) delete process.env[name!];
    else process.env[name!] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const { loadPlugin } = await import("../host/plugins.ts");
const { default: desktop, notifyCommand } = await import("../plugins/desktop/channel.ts");

const TITLE = "Agent 问你一个问题";
const WORDS = "运行 agent-autoloop status 查看";
const body = (title: string) => `${title}\n${WORDS}`;
const base: Card = {
  id: 5,
  version: 1,
  content_version: 1,
  input: null,
  ref: null,
  kind: "ask",
  state: "open",
  title: "要不要删",
  text: "占了 10 GB",
  options: ["删", "留着"],
  recommend: null,
  choice: null,
  answer: null,
  result: null,
  link: null,
};

let fakes = 0;
/** A folder that's all of PATH, with both notify commands doing `body` after writing down the arguments they got. */
function standIns(body = "") {
  const bin = join(dir, `bin-${++fakes}`);
  mkdirSync(bin);
  const said = join(bin, "said");
  writeFileSync(join(bin, "launchctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.DISPLAY = ":99";
  process.env.SESSIONNAME = "Console";
  for (const name of ["osascript", "notify-send", "powershell.exe"]) {
    writeFileSync(
      join(bin, name),
      `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(said)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n${body}\n`,
      { mode: 0o755 },
    );
  }
  process.env.PATH = bin;
  return {
    calls: () =>
      existsSync(said)
        ? readFileSync(said, "utf8")
            .trim()
            .split("\n")
            .map((call) => JSON.parse(call) as string[])
            .map((call) =>
              process.platform === "win32"
                ? [
                    ...call.slice(0, -2),
                    "--",
                    ...call.slice(-2).map((word) => Buffer.from(word, "base64").toString("utf8")),
                  ]
                : call,
            )
        : [],
  };
}

async function deliver(cards: Card[]) {
  const stop = new AbortController();
  const queue = [...cards];
  const reports: unknown[][] = [];
  const logged: string[] = [];
  const hub = {
    async nextCard() {
      if (queue.length) return { card: queue.shift()! };
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      reports.push(["delivered", ...args]);
      return {};
    },
    async failed(...args: unknown[]) {
      reports.push(["failed", args[0], args[1]]);
      return {};
    },
    async answer() {
      return {};
    },
  };
  await desktop({ hub: hub as any, options: {}, log: (line: string) => logged.push(line), signal: stop.signal });
  return { reports, logged };
}

test("it ships as a channel, and is told apart by platform", async () => {
  assert.equal(await loadPlugin("desktop", "channel"), desktop);
  assert.deepEqual(notifyCommand("标题", "linux"), ["notify-send", ["--", TITLE, body("标题")]]);
  const [program, args] = notifyCommand("标题", "darwin");
  assert.equal(program, "osascript");
  assert.deepEqual(args.slice(args.indexOf("--")), ["--", TITLE, body("标题")]);
  assert.ok(args.includes("on run argv"));
  const [windows, windowsArgs] = notifyCommand("$(Start-Process calc); <标题>", "win32");
  assert.equal(windows, "powershell.exe");
  assert.ok(windowsArgs.includes("-File"));
  assert.equal(Buffer.from(windowsArgs.at(-2)!, "base64").toString("utf8"), TITLE);
  assert.equal(Buffer.from(windowsArgs.at(-1)!, "base64").toString("utf8"), body("$(Start-Process calc); <标题>"));
});

test(
  "the Windows notification script parses without displaying anything",
  { skip: process.platform !== "win32" },
  () => {
    const file = Buffer.from(join(import.meta.dirname, "../plugins/desktop/notify.ps1")).toString("base64");
    const script = `$tokens=$null; $errors=$null; $file=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${file}')); [void][System.Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors); if($errors.Count) { $errors | ForEach-Object { [Console]::Error.WriteLine($_) }; exit 1 }`;
    const parsed = spawnSync(
      join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(parsed.status, 0, parsed.stderr);
  },
);

test("a new card notifies once with its title; an update only reports", async () => {
  const fake = standIns();
  const { reports } = await deliver([base, { ...base, version: 2, ref: "shown-5", state: "decided", choice: 1 }]);
  assert.equal(fake.calls().length, 1);
  assert.deepEqual(fake.calls()[0].slice(-2), [TITLE, body("要不要删")]);
  assert.deepEqual(reports, [
    ["delivered", 5, 1, "shown-5"],
    ["delivered", 5, 2, "shown-5"],
  ]);
});

test("an FYI announces information, and its update does not notify again", async () => {
  const fake = standIns();
  const card: Card = { ...base, kind: "notice", state: "closed", fyi: true, options: [] };
  const { reports } = await deliver([card, { ...card, version: 2, ref: "shown-5" }]);
  assert.equal(fake.calls().length, 1);
  assert.deepEqual(fake.calls()[0].slice(-2), ["Agent 告诉你一件事", body(card.title)]);
  assert.equal(reports.length, 2);
});

const marker = join(dir, "ran");
const hostile = [
  `" & (do shell script "touch ${marker}") & "`,
  `"; do shell script "touch ${marker}"; "`,
  `end run\ndo shell script "touch ${marker}"`,
  `$(touch ${marker})`,
  `\`touch ${marker}\``,
  `'; touch ${marker}; '`,
  "-e",
  `-e do shell script "touch ${marker}"`,
  "--",
  "--help",
];

test("what an Agent wrote goes in as one argument after the options, and never into the script", async () => {
  const fake = standIns();
  const { reports } = await deliver(hostile.map((title, index) => ({ ...base, id: index + 1, title })));
  assert.ok(reports.every(([what]) => what === "delivered"));
  const calls = fake.calls();
  assert.equal(calls.length, hostile.length);
  const scriptOf = (call: string[]) => call.slice(0, call.indexOf("--"));
  calls.forEach((call, index) => {
    assert.deepEqual(call.slice(call.indexOf("--")), ["--", TITLE, body(hostile[index])]);
    assert.deepEqual(scriptOf(call), scriptOf(calls[0]), "the script is the same whatever the card says");
  });
  assert.ok(!scriptOf(calls[0]).join("\n").includes("touch"));
  assert.ok(!existsSync(marker));
});

test(
  "the real osascript reads them as words and runs none of them",
  { skip: process.platform !== "darwin" },
  async () => {
    for (const title of hostile) {
      const [, args] = notifyCommand(title, "darwin");
      const onlyPrints = args.map((word) => (word.startsWith("display notification") ? "return item 2 of argv" : word));
      const printed = execFileSync("/usr/bin/osascript", onlyPrints, { encoding: "utf8" });
      assert.equal(printed.replace(/\n$/, ""), body(title));
    }
    assert.ok(!existsSync(marker));
  },
);

test("without a graphical session it quietly skips notification and keeps consuming cards", async () => {
  mkdirSync(join(dir, "nothing-here"));
  process.env.PATH = join(dir, "nothing-here");
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  process.env.SESSIONNAME = "Services";
  const { reports, logged } = await deliver([base, { ...base, id: 6 }]);
  assert.deepEqual(reports, [
    ["delivered", 5, 1, "skipped-5"],
    ["delivered", 6, 1, "skipped-6"],
  ]);
  assert.deepEqual(logged, []);
});

test("a notifier that fails is reported as not sent", async () => {
  standIns("process.exit(1)");
  assert.deepEqual((await deliver([base])).reports, [["failed", 5, 1]]);
});

test("a title no program can be given is reported, and takes nothing down", async () => {
  const fake = standIns();
  const { reports } = await deliver([
    { ...base, title: "a\0b" },
    { ...base, id: 6 },
  ]);
  assert.deepEqual(reports, [
    ["failed", 5, 1],
    ["delivered", 6, 1, "shown-6"],
  ]);
  assert.equal(fake.calls().length, 1);
});

test("a slow notifier doesn't freeze the process the hub runs in", async () => {
  standIns("setTimeout(() => {}, 300)");
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 10);
  await deliver([base]);
  clearInterval(ticker);
  assert.ok(ticks >= 5, `only ${ticks} ticks while it was showing`);
});

const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const program = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, ...args], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
const installEnv = (place: string) => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: realPath,
    HOME: place,
    USERPROFILE: place,
    AGENT_AUTOLOOP_HOME: place,
  };
  delete env.AGENT_AUTOLOOP_RULES;
  delete env.AGENT_AUTOLOOP_PUBLIC_URL;
  return env;
};

test("init turns it on in both files, with a key of its own", () => {
  const place = join(dir, "new");
  const env = installEnv(place);
  const done = program(env, "init", "--no-service", "--command", "true", "--port", "3999");
  assert.equal(done.status, 0, done.stderr);
  const rules = JSON.parse(readFileSync(join(place, "rules.json"), "utf8"));
  const config = JSON.parse(readFileSync(join(place, "config.json"), "utf8"));
  assert.deepEqual(rules.channels, { desktop: { name: "桌面通知" } });
  assert.deepEqual(Object.keys(config.channels), ["desktop"]);
  assert.ok(config.channels.desktop.key.length > 20);
  assert.match(program(env, "key", "list").stdout, /^channel desktop /m);
  assert.match(done.stdout, /桌面通知/);
});

test("a rules file already there stays as it was, and no channel is added beside it", () => {
  const place = join(dir, "theirs");
  mkdirSync(place);
  const theirs = JSON.stringify(rulesWith({}));
  writeFileSync(join(place, "rules.json"), theirs);
  const done = program(installEnv(place), "init", "--no-service", "--command", "true", "--port", "3999");
  assert.equal(done.status, 0, done.stderr);
  assert.equal(readFileSync(join(place, "rules.json"), "utf8"), theirs);
  assert.equal(JSON.parse(readFileSync(join(place, "config.json"), "utf8")).channels, undefined);
  assert.doesNotMatch(program(installEnv(place), "key", "list").stdout, /^channel /m);
});

test("doctor says what reaches you: only this computer, or nothing yet, or no word of either", async () => {
  const { serve } = await import("../host/http.ts");
  const hub = await import("../host/runtime.ts");
  const server = serve(0);
  await new Promise((resolve) => server.once("listening", resolve));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      owner: hub.addKey("owner", "me"),
      hub: { listen: "127.0.0.1:0" },
    }),
  );
  try {
    const hint = async (channels: object) => {
      writeFileSync(rulesFile, JSON.stringify(rulesWith(channels)));
      hub.reloadRules(rulesFile);
      const env = { ...process.env, PATH: realPath };
      const args = ["--disable-warning=ExperimentalWarning", bin, "doctor"];
      return new Promise<string>((resolve) => {
        execFile(process.execPath, args, { env, encoding: "utf8" }, (_error, stdout) => resolve(stdout));
      });
    };
    const alone = await hint({ desktop: { name: "桌面通知" } });
    assert.match(alone, /只接了桌面通知/);
    assert.doesNotMatch(alone, /还没接通道/);
    const none = await hint({});
    assert.match(none, /还没接通道/);
    assert.doesNotMatch(none, /只接了桌面通知/);
    const more = await hint({ desktop: { name: "桌面通知" }, feishu: { name: "飞书" } });
    assert.doesNotMatch(more, /只接了桌面通知|还没接通道/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
