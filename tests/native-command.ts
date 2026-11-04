// Windows cannot execute a shebang fixture; compile a native launcher without installing a test dependency.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

let launcher: string | undefined;
let temporary: string | undefined;
after(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

export function nativeCommand(file: string, source: string) {
  if (process.platform !== "win32") {
    writeFileSync(file, `#!${process.execPath}\n${source}`, { mode: 0o755 });
    return file;
  }
  if (!launcher) {
    const dir = mkdtempSync(join(tmpdir(), "autoloop-native-fixture-"));
    temporary = dir;
    launcher = join(dir, "launcher.exe");
    const code = join(dir, "launcher.cs");
    writeFileSync(
      code,
      `
using System;
using System.Diagnostics;
using System.Reflection;
using System.Text;
public static class Launcher {
  static string Quote(string value) {
    var result = new StringBuilder("\\\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\\\') { slashes++; continue; }
      result.Append('\\\\', slashes * (c == '\\"' ? 2 : 1));
      if (c == '\\"') result.Append('\\\\');
      result.Append(c);
      slashes = 0;
    }
    return result.Append('\\\\', slashes * 2).Append('\\"').ToString();
  }
  public static int Main(string[] args) {
    var argv = new StringBuilder(Quote(Assembly.GetExecutingAssembly().Location + ".mjs"));
    foreach (var arg in args) argv.Append(' ').Append(Quote(arg));
    using (var child = Process.Start(new ProcessStartInfo(${JSON.stringify(process.execPath)}, argv.ToString()) {
      UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
    })) {
      var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
      var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
      child.WaitForExit();
      System.Threading.Tasks.Task.WaitAll(output, error);
      return child.ExitCode;
    }
  }
}
`,
    );
    const compile = join(dir, "compile.ps1");
    writeFileSync(
      compile,
      "Add-Type -TypeDefinition ([IO.File]::ReadAllText($args[0])) -OutputAssembly $args[1] -OutputType ConsoleApplication\n",
    );
    execFileSync(
      join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", compile, code, launcher],
      { windowsHide: true, stdio: "pipe" },
    );
  }
  const executable = `${file}.exe`;
  copyFileSync(launcher, executable);
  writeFileSync(`${executable}.mjs`, source);
  return executable;
}
