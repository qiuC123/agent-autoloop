// Windows cannot exec npm's batch shims or a shebang. Resolve Node entry points without putting arguments in a shell.
import { existsSync, openSync, readSync, closeSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export function command(program: string, args: string[] = []): [string, ...string[]] {
  if (process.platform !== "win32") return [program, ...args];
  const folders = /[\\/]/.test(program) ? [""] : (process.env.PATH ?? "").split(path.delimiter);
  const extensions = path.extname(program) ? [""] : ["", ".exe", ".com", ".cmd", ".bat"];
  const file = folders
    .flatMap((folder) => extensions.map((ext) => path.resolve(folder, program + ext)))
    .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!file) return [program, ...args];
  const fd = openSync(file, "r");
  let prefix: string;
  try {
    const buffer = Buffer.alloc(256);
    prefix = buffer.subarray(0, readSync(fd, buffer)).toString("utf8");
  } finally {
    closeSync(fd);
  }
  if (/^#![^\r\n]*\bnode(?:\.exe)?(?:\s|\r?\n|$)/.test(prefix)) return [process.execPath, file, ...args];
  if (/\.(cmd|bat)$/i.test(file)) {
    const shim = readFileSync(file, "utf8");
    const entry =
      /^(?:endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & )?@?(?:node(?:\.exe)?|"%_prog%")[ \t]+"(?:%~dp0|%dp0%)[\\/]([^"\r\n]+\.(?:[cm]?js|ts))"[ \t]+%\*[ \t]*$/im.exec(
        shim,
      );
    if (entry) {
      return [process.execPath, path.resolve(path.dirname(file), entry[1]), ...args];
    }
    throw new Error(`Windows 请使用原生程序或 node + 脚本路径：${file}`);
  }
  return [file, ...args];
}
