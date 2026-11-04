// Probe the configured sandbox instead of guessing its account or granting the entire sandbox group access.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { command } from "../../host/command.ts";
import { agentDirectory } from "../../host/private.ts";
import type { Turn } from "../../worker/agents.ts";

export function prepareWindows(program: string, mode: string, turn: Turn, env: NodeJS.ProcessEnv) {
  if (process.platform !== "win32" || turn.access === "full") return;
  const powershell = path.join(env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const probe = "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value";
  const [executable, ...args] = command(program, [
    "sandbox",
    "-c",
    `sandbox_mode="${mode}"`,
    "--",
    powershell,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(probe, "utf16le").toString("base64"),
  ]);
  const sid = execFileSync(executable, args, {
    cwd: turn.cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 30_000,
  }).trim();
  agentDirectory(turn.folder, sid, turn.access);
}
