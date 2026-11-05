// A detached guardian owns a kill-on-close Job Object. A persisted random name lets a new worker inspect or stop it.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HOME } from "../host/home.ts";
import { privateDirectory, privateFile, writePrivateFile } from "../host/private.ts";
import { command } from "../host/command.ts";

let executable: string | undefined;
function helper() {
  if (executable) return executable;
  const source = path.join(import.meta.dirname, "windows-job.cs");
  const directory = path.join(HOME, "worker");
  privateDirectory(directory);
  const digest = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16);
  const output = path.join(directory, `windows-job-${digest}.exe`);
  if (!existsSync(output)) {
    const compiler = ["Framework64", "Framework"]
      .map((framework) =>
        path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", framework, "v4.0.30319", "csc.exe"),
      )
      .find(existsSync);
    if (!compiler) throw new Error("Windows 需要系统自带的 .NET Framework 4.x 编译器");
    execFileSync(compiler, ["/nologo", "/target:exe", `/out:${output}`, source], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  }
  privateFile(output);
  return (executable = output);
}

export function windowsAlive(name: string, spec: string) {
  const result = spawnSync(helper(), ["query", name, spec], { timeout: 30_000, windowsHide: true, encoding: "utf8" });
  if (result.status === 3) return false;
  if (result.status !== 0) throw new Error(`检查 Windows 进程失败：${result.error?.message ?? result.stderr}`);
  return true;
}

export function windowsStop(name: string, spec: string) {
  const result = spawnSync(helper(), ["stop", name, spec], { timeout: 30_000, windowsHide: true, encoding: "utf8" });
  if (result.status !== 0 && result.status !== 3)
    throw new Error(`停止 Windows 进程失败：${result.error?.message ?? result.stderr}`);
}

export function launchWindows(
  name: string,
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  files: { out: string; err: string; exit: string },
  log: (line: string) => void,
) {
  const ready = `${files.exit}.ready`;
  const spec = `${files.exit}.launch`;
  const resolved = command(argv[0], argv.slice(1));
  writePrivateFile(
    spec,
    [cwd, files.out, files.err, files.exit, ready, ...resolved]
      .map((value) => Buffer.from(value).toString("base64"))
      .join("\n") + "\n",
  );
  const child = spawn(helper(), ["run", name, spec], { cwd, env, detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", (error) => log(String(error)));
  child.unref();
  const deadline = Date.now() + 10_000;
  while (!existsSync(ready) && !existsSync(files.exit)) {
    if (Date.now() >= deadline) {
      windowsStop(name, spec);
      throw new Error("Windows 进程没有确认启动");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return child;
}
