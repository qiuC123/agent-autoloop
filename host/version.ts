// Which code this is: the version in package.json and the commit it's at.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");

/** What was deployed, or the checkout's commit. Git says: after a gc a branch's ref is no longer a file of its own. */
export async function commitOf(root = ROOT) {
  if (process.env.AGENT_AUTOLOOP_COMMIT) return process.env.AGENT_AUTOLOOP_COMMIT;
  try {
    // Only a checkout has its own .git entry; unpacked copies must not inherit a parent repository's commit.
    if (!existsSync(path.join(root, ".git"))) return "dev";
    const args = ["-C", root, "rev-parse", "HEAD"];
    return (
      await promisify(execFile)("git", args, { timeout: 5_000, encoding: "utf8", windowsHide: true })
    ).stdout.trim();
  } catch {
    return "dev";
  }
}

export async function versionLine() {
  const { version } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  return `agent-autoloop ${version}（提交 ${(await commitOf()).slice(0, 12)}）`;
}
