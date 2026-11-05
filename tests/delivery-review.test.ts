// Failure modes: empty/failed reviews pass; findings are unhandled but attested; Codex reads developer
// config or memories, writes files, sees credentials, or executes a PR's programs/settings. Review receives a text snapshot.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReview, codexCommand, reviewSnapshot } from "../plugins/delivery/review.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settings } from "../plugins/delivery/project.ts";
test("a review must explicitly report a valid findings list", () => {
  assert.deepEqual(parseReview('{"findings":[]}'), []);
  assert.equal(parseReview('{"findings":[{"title":"错误","text":"这里会丢数据"}]}').length, 1);
  for (const text of ["", "Reviewer failed", "{}", '{"findings":null}', '{"findings":[{}]}'])
    assert.throws(() => parseReview(text));
});
test("Codex ignores developer configuration and only reads the review snapshot", () => {
  const argv = codexCommand("/tmp/snapshot/output.json", "high");
  for (const flag of ["--ignore-user-config", "--ephemeral", "memories", "read-only"]) assert.ok(argv.includes(flag));
  assert.ok(argv.includes('default_permissions="review"'));
  const policy = argv.find((v) => v.startsWith("permissions.review.filesystem="))!;
  assert.match(policy, /workspace_roots/);
  assert.ok(!policy.includes(".codex"));
  assert.ok(!policy.includes(".ssh"));
});
test("review uses main's points and a text-only snapshot; ordinary internal docs skip the reviewer", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-autoloop-review-"));
  try {
    const repo = join(root, "repo");
    const snap = join(root, "snapshot");
    mkdirSync(repo);
    mkdirSync(join(repo, "docs"));
    const git = (...a: string[]) =>
      execFileSync("git", a, {
        timeout: 30_000,
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const commit = () => {
      git("add", "-A");
      git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "test");
      return git("rev-parse", "HEAD");
    };
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "AGENTS.md"), "## 审查要点\nmain-points\n");
    writeFileSync(join(repo, "app.ts"), "throw new Error('must not execute');");
    const main = commit();
    const reviewer = join(root, "reviewer.mjs");
    const called = join(root, "called");
    writeFileSync(
      reviewer,
      `import fs from 'node:fs';let input='';for await(const b of process.stdin)input+=b;if(!input.includes('main-points'))process.exit(1);fs.writeFileSync(${JSON.stringify(called)},'yes');console.log('{"findings":[]}');`,
    );
    const s = settings({
      repo: "example/app",
      internal: ["docs/*.md"],
      review: { points: "AGENTS.md", command: [process.execPath, reviewer] },
    });
    writeFileSync(join(repo, "docs/a.md"), "docs");
    const docs = commit();
    assert.deepEqual(await reviewSnapshot(repo, snap, main, docs, s), []);
    assert.ok(!existsSync(called));
    writeFileSync(join(repo, "AGENTS.md"), "## 审查要点\nbranch-points\n");
    writeFileSync(join(repo, "app.ts"), "throw new Error('changed');");
    const head = commit();
    assert.deepEqual(await reviewSnapshot(repo, snap, main, head, s), []);
    assert.ok(existsSync(called));
    assert.deepEqual(readdirSync(snap), ["changes.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
