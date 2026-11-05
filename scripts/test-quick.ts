// Use Node's file enumeration so the same test set runs in cmd, PowerShell and POSIX shells.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
const files = readdirSync("tests").filter((file) => file.endsWith(".test.ts") && file !== "simulation.test.ts");
const result = spawn(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", "--test", ...files.map((file) => `tests/${file}`)],
  { stdio: "inherit" },
);
result.on("error", (error) => {
  throw error;
});
result.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
