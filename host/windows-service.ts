// Task Scheduler retries the runner every five minutes; a persistent stop suppresses future launches.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { privateDirectory, writePrivateFile } from "./private.ts";
import { windowsUserSid } from "./windows-acl.ts";
import { listenForControl, requestControl } from "./windows-control.ts";

type Command = (
  program: string,
  args: string[],
) => { status: number | null; stdout: string; stderr?: string; error?: Error };
type Options = {
  home: string;
  user?: string;
  node?: string;
  program?: string;
  runner?: string;
  searchPath?: string;
  run?: Command;
};
const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const quote = (text: string) => '"' + text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"';
const execute: Command = (program, args) =>
  spawnSync(program, args, { encoding: "utf8", windowsHide: true, timeout: 30_000 });

function only(xml: string, name: string) {
  const elements = [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, "g"))];
  return elements.length === 1 ? elements[0][1] : null;
}
function text(xml: string, name: string) {
  const value = only(xml, name);
  if (value === null || value.includes("<")) return null;
  return value
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
      if (entity.startsWith("#"))
        return String.fromCodePoint(parseInt(entity.slice(entity[1] === "x" ? 2 : 1), entity[1] === "x" ? 16 : 10));
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity];
    })
    .trim();
}

export function windowsService(options: Options) {
  const { home, node = process.execPath, searchPath = process.env.PATH ?? "", run = execute } = options;
  const program = options.program ?? path.join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
  const runner = options.runner ?? path.join(import.meta.dirname, "windows-service.ts");
  const name = `agent-autoloop-${createHash("sha256")
    .update((existsSync(home) ? realpathSync(home) : path.resolve(home)).toLowerCase())
    .digest("hex")
    .slice(0, 16)}`;
  const taskFile = path.join(home, "service-task.xml");
  const configFile = path.join(home, "service.json");
  let owner = options.user;
  const user = () => (owner ??= windowsUserSid());
  const xml = () => `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>agent-autoloop ${escape(program)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${escape(user())}</UserId></LogonTrigger><TimeTrigger><Repetition><Interval>PT5M</Interval></Repetition><StartBoundary>${new Date(Date.now() + 300_000).toISOString()}</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>
  <Principals><Principal id="Owner"><UserId>${escape(user())}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>
  <Actions Context="Owner"><Exec><Command>${escape(node)}</Command><Arguments>${escape(["--disable-warning=ExperimentalWarning", runner, configFile].map(quote).join(" "))}</Arguments><WorkingDirectory>${escape(home)}</WorkingDirectory></Exec></Actions>
</Task>
`;
  // schtasks exports XML in the OEM code page; Base64 preserves every character without changing console settings.
  const queryScript = `$ErrorActionPreference='Stop';$s=[Activator]::CreateInstance([Type]::GetTypeFromProgID('Schedule.Service'));$s.Connect();$n=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(name).toString("base64")}'));[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s.GetFolder('\\').GetTask($n).Xml)))`;
  const queryCommand: [string, string[]] = [
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(queryScript, "utf16le").toString("base64"),
    ],
  ];
  const query = () => {
    const result = run(...queryCommand);
    return { ...result, stdout: Buffer.from(result.stdout.trim(), "base64").toString("utf8") };
  };
  const owned = (content: string) => {
    try {
      if (/<!/.test(content)) return false;
      const actions = only(content, "Actions") ?? "";
      const principal = only(only(content, "Principals") ?? "", "Principal") ?? "";
      const exec = only(actions, "Exec") ?? "";
      const samePath = (value: string | null, expected: string) =>
        value !== null && path.win32.normalize(value).toLowerCase() === path.win32.normalize(expected).toLowerCase();
      return (
        !/<(?:ComHandler|SendEmail|ShowMessage)\b/.test(actions) &&
        text(content, "Description") === `agent-autoloop ${program}` &&
        samePath(text(exec, "Command"), node) &&
        text(exec, "Arguments") ===
          ["--disable-warning=ExperimentalWarning", runner, configFile].map(quote).join(" ") &&
        samePath(text(exec, "WorkingDirectory"), home) &&
        text(principal, "UserId") === user()
      );
    } catch {
      return false;
    }
  };
  const checked = (args: string[]) => {
    const result = run("schtasks.exe", args);
    if (result.status !== 0) throw new Error(`计划任务没设置好：${result.stderr || result.stdout || args[0]}`);
  };
  return {
    name,
    taskFile,
    configFile,
    xml,
    queryCommand,
    install() {
      const registered = query();
      if (registered.error) throw registered.error;
      if (registered.status === 0 && !owned(registered.stdout)) throw new Error(`同名计划任务不是本程序：${name}`);
      privateDirectory(home);
      privateDirectory(path.join(home, "logs"));
      const agentHomes = Object.fromEntries(
        ["HOME", "USERPROFILE", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"].flatMap((key) =>
          process.env[key] === undefined ? [] : [[key, process.env[key]]],
        ),
      );
      if (process.env.AGENT_AUTOLOOP_RULES !== undefined)
        agentHomes.AGENT_AUTOLOOP_RULES = path.resolve(process.env.AGENT_AUTOLOOP_RULES);
      writePrivateFile(configFile, JSON.stringify({ home, node, program, searchPath, agentHomes }) + "\n");
      writePrivateFile(taskFile, Buffer.from("\ufeff" + xml(), "utf16le"));
      checked(["/Create", "/TN", name, "/XML", taskFile, "/F"]);
      rmSync(path.join(home, "service.stopped"), { force: true });
      checked(["/Run", "/TN", name]);
    },
    remove() {
      if (!existsSync(taskFile)) return;
      const registered = query();
      if (registered.status !== 0 || !owned(registered.stdout)) return;
      checked(["/Delete", "/TN", name, "/F"]);
      rmSync(taskFile, { force: true });
      rmSync(configFile, { force: true });
    },
    installed() {
      if (!existsSync(taskFile)) return false;
      const registered = query();
      return registered.status === 0 && owned(registered.stdout);
    },
  };
}

type Configuration = { home: string; node: string; program: string; searchPath: string; agentHomes: NodeJS.ProcessEnv };

export function launchServiceUp({ home, node, program, searchPath, agentHomes }: Configuration, log: number) {
  return spawn(node, ["--disable-warning=ExperimentalWarning", program, "up"], {
    env: { ...process.env, ...agentHomes, AGENT_AUTOLOOP_HOME: home, PATH: searchPath },
    cwd: home,
    windowsHide: true,
    stdio: ["ignore", log, log],
  });
}

export async function runWindowsService(configuration: Configuration) {
  const { home } = configuration;
  const stopped = path.join(home, "service.stopped");
  if (existsSync(stopped)) return;
  const stop = new AbortController();
  const ignore = () => {};
  for (const signal of ["SIGINT", "SIGBREAK"] as const) process.on(signal, ignore);
  const unlock = await listenForControl(home, () => stop.abort(), "service");
  const log = openSync(path.join(home, "logs", "up.log"), "a");
  const say = (message: string) => writeSync(log, `${new Date().toISOString()} [service] ${message}\n`);
  const wait = (ms: number) => delay(ms, undefined, { signal: stop.signal }).catch(() => {});
  let failures = 0;
  try {
    while (!stop.signal.aborted && !existsSync(stopped)) {
      const child = launchServiceUp(configuration, log);
      let ended = false;
      const exited = new Promise<void>((resolve) => {
        const finish = (reason: string) => {
          if (ended) return;
          ended = true;
          say(`up 退出：${reason}`);
          resolve();
        };
        child.on("error", (error) => {
          if (!child.pid) finish(error.message);
          else say(`up 进程操作失败：${error.message}`);
        });
        child.once("exit", (code, signal) => finish(String(code ?? signal)));
      });
      let lastHealthy = performance.now();
      let healthySince: number | undefined;
      while (!ended && !stop.signal.aborted) {
        await Promise.race([exited, wait(15_000)]);
        if (ended || stop.signal.aborted) break;
        const healthy = await requestControl(home, "status", "up", child.pid);
        if (ended || stop.signal.aborted) break;
        const now = performance.now();
        if (healthy !== null) {
          lastHealthy = now;
          healthySince ??= now;
          if (now - healthySince >= 300_000) failures = 0;
        } else {
          healthySince = undefined;
          // Agent work is in other processes; even a long turn must leave the local control loop responsive.
          if (now - lastHealthy >= 300_000) {
            say("up 连续 5 分钟没有回应，结束 up 后重启，保留独立 Agent");
            // libuv reaps non-detached children; detached Job guardians must survive for adoption.
            child.kill("SIGKILL");
          }
        }
      }
      if (stop.signal.aborted) {
        say("收到 service stop，停止看管");
        if (!ended) {
          await requestControl(home, "stop", "up", child.pid);
          await Promise.race([exited, delay(5_000, undefined, { ref: false })]);
          // Normal stop preserves detached Agents, just as foreground up does.
          if (!ended) child.kill("SIGKILL");
          await exited;
        }
        break;
      }
      const backoff = Math.min(60_000, 1_000 * 2 ** Math.min(failures++, 6));
      say(`将在 ${backoff} 毫秒后重启 up`);
      await wait(backoff);
    }
  } finally {
    unlock();
    closeSync(log);
    for (const signal of ["SIGINT", "SIGBREAK"] as const) process.off(signal, ignore);
  }
}

if (import.meta.main) await runWindowsService(JSON.parse(readFileSync(process.argv[2], "utf8")));
