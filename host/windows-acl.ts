// Bootstrap an empty private scratch directory before compiling; never execute a shared cached binary.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const system = (program: string) => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", program);
let sid: string | undefined;
export function windowsUserSid() {
  if (sid) return sid;
  const output = execFileSync(system("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const found = /"(S-1-\d+(?:-\d+)+)"/.exec(output)?.[1];
  if (!found) throw new Error("无法取得当前 Windows 用户 SID");
  return (sid = found);
}

let executable: string | undefined;
export function aclHelper() {
  if (executable) return executable;
  const home = process.env.AGENT_AUTOLOOP_HOME;
  const directory = mkdtempSync(path.join(home && existsSync(home) ? home : tmpdir(), "autoloop-acl-"));
  try {
    execFileSync(system("icacls.exe"), [directory, "/inheritance:r", "/grant:r", `*${windowsUserSid()}:(OI)(CI)F`], {
      windowsHide: true,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const compiler = ["Framework64", "Framework"]
      .map((framework) =>
        path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", framework, "v4.0.30319", "csc.exe"),
      )
      .find(existsSync);
    if (!compiler) throw new Error("Windows 需要系统自带的 .NET Framework 4.x 编译器");
    const output = path.join(directory, "acl.exe");
    execFileSync(
      compiler,
      ["/nologo", "/target:exe", `/out:${output}`, path.join(import.meta.dirname, "windows-acl.cs")],
      {
        windowsHide: true,
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
    return (executable = output);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
