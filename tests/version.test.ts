// `agent-autoloop --version`: what someone pastes into a bug report. Failure cases: it needs an install to answer; the version
// isn't package.json's; a commit whose ref has been packed away (what a clone comes to after a gc) reads as unknown, or a
// copy unpacked inside some other repository reads as that repository's commit.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { commitOf } from "../host/version.ts";
import { nativeCommand } from "./native-command.ts";
import { delimiter } from "node:path";

const root = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-version-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    timeout: 30_000,
    cwd,
    encoding: "utf8",
  }).trim();

test("it prints package.json's version and this checkout's commit, with nothing installed", () => {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const empty = join(dir, "nothing-installed");
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_AUTOLOOP_HOME: empty };
  delete env.AGENT_AUTOLOOP_COMMIT;
  const done = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(root, "bin", "agent-autoloop.ts"), "--version"],
    { timeout: 30_000, env, encoding: "utf8" },
  );
  assert.equal(done.status, 0, done.stderr);
  const commit = git(root, "rev-parse", "HEAD").slice(0, 12);
  assert.equal(done.stdout.trim(), `agent-autoloop ${version}（提交 ${commit}）`);
  assert.ok(!existsSync(empty), "asking the version sets nothing up");
});

test("a commit reads the same whether its ref is a file or packed away, and a deployment's word counts", async () => {
  const before = process.env.AGENT_AUTOLOOP_COMMIT;
  delete process.env.AGENT_AUTOLOOP_COMMIT;
  const clone = join(dir, "clone");
  mkdirSync(clone);
  git(clone, "init", "-q", "-b", "main");
  writeFileSync(join(clone, "file"), "x");
  git(clone, "add", "file");
  git(clone, "commit", "-qm", "x");
  const head = git(clone, "rev-parse", "HEAD");
  assert.equal(await commitOf(clone), head);
  git(clone, "pack-refs", "--all");
  assert.ok(!existsSync(join(clone, ".git", "refs", "heads", "main")));
  assert.equal(await commitOf(clone), head);

  mkdirSync(join(clone, "vendored"));
  assert.equal(await commitOf(join(clone, "vendored")), "dev", "a copy inside a repository isn't at its commit");
  assert.equal(await commitOf(join(dir, "no-such-folder")), "dev");

  process.env.AGENT_AUTOLOOP_COMMIT = "deployed";
  assert.equal(await commitOf(clone), "deployed");
  if (before === undefined) delete process.env.AGENT_AUTOLOOP_COMMIT;
  else process.env.AGENT_AUTOLOOP_COMMIT = before;
});

test("reading the health version leaves the hub event loop responsive during Git", async () => {
  const commands = join(dir, "commands");
  mkdirSync(commands);
  nativeCommand(join(commands, "git"), "setTimeout(()=>console.log('test-commit'),250);");
  const oldPath = process.env.PATH;
  const oldCommit = process.env.AGENT_AUTOLOOP_COMMIT;
  delete process.env.AGENT_AUTOLOOP_COMMIT;
  process.env.PATH = commands + delimiter + oldPath;
  let ticked = false;
  const timer = setTimeout(() => {
    ticked = true;
  }, 10);
  try {
    assert.equal(await commitOf(root), "test-commit");
    assert.equal(ticked, true, "Git must not block hub timers");
  } finally {
    clearTimeout(timer);
    process.env.PATH = oldPath;
    if (oldCommit === undefined) delete process.env.AGENT_AUTOLOOP_COMMIT;
    else process.env.AGENT_AUTOLOOP_COMMIT = oldCommit;
  }
});
