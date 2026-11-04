// Use Node's file enumeration so the same test set runs in cmd, PowerShell and POSIX shells.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
const files = readdirSync("tests").filter((file) => file.endsWith(".test.ts") && file !== "simulation.test.ts");
const result = spawnSync(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", "--test", ...files.map((file) => `tests/${file}`)],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
