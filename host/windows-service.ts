// The scheduled task runs with the logged-in user's token; only Task Scheduler calls are injectable.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { privateDirectory, writePrivateFile } from "./private.ts";

type Command = (program: string, args: string[]) => { status: number | null; stdout: string; stderr?: string };
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
const execute: Command = (program, args) => spawnSync(program, args, { encoding: "utf8", windowsHide: true });

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
  const user = () =>
    (owner ??= execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim());
  const xml = () => `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>agent-autoloop ${escape(program)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${escape(user())}</UserId></LogonTrigger></Triggers>
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

if (import.meta.main) {
  const { home, node, program, searchPath, agentHomes } = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const log = openSync(path.join(home, "logs", "up.log"), "a");
  const child = spawn(node, ["--disable-warning=ExperimentalWarning", program, "up"], {
    env: { ...process.env, ...agentHomes, AGENT_AUTOLOOP_HOME: home, PATH: searchPath },
    cwd: home,
    windowsHide: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
