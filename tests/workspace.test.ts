// Failure modes: answers or timers resume a session in a new folder; repeated follow-ups lose the first workspace;
// queue/retry merging drops the workspace, or changing agents inherits another agent's session and folder.
// Missing legacy fields must survive restart/rebuild; fixed-cwd rules must not gain workspace job fields.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { World, rules, environment } from "../sim/world.ts";
import { decide } from "../kernel/decide.ts";
import { commit, openView } from "../kernel/store.ts";
import { jobOf } from "../kernel/query.ts";
import type { Job } from "../protocol/job.ts";

function world(t: TestContext, workspace = true) {
  const w = new World();
  t.after(() => w.view.close());
  const config = structuredClone(rules);
  if (workspace) config.rules[0].workspace = "run";
  w.call("rules", config);
  return w;
}
const ingest = (w: World, id: string) => w.call("ingest", "app", { id, type: "one", subject: "task" });
const claim = (w: World): Job => w.call("claimNext", "w1", `claim-${w.transitions}`);
function defer(w: World, job: Job, kind: "ask" | "later", session?: string) {
  w.finish(job.run, {
    outcome: "done",
    ...(session && { session }),
    ...(kind === "ask"
      ? { ask: [{ key: `q-${job.run}`, title: "继续？", text: "请决定", options: ["是", "否"] }] }
      : { later: [{ key: `t-${job.run}`, at: new Date(w.now + 60_000).toISOString(), about: "复查" }] }),
  });
}
function wake(w: World, kind: "ask" | "later") {
  if (kind === "ask") w.call("answer", w.view.next.cards, { choice: 0 });
  else w.advance(60_000);
}

for (const kind of ["ask", "later"] as const) {
  for (const session of [undefined, "original-session"]) {
    test(`${kind} follow-ups keep the first workspace across restarts (${session ?? "no session"})`, (t) => {
      const w = world(t);
      ingest(w, "first");
      let job = claim(w);
      const first = job.run;
      assert.equal(job.workspaceRun, first);
      for (let i = 0; i < 3; i++) {
        defer(w, job, kind, session);
        w.restart();
        wake(w, kind);
        const next = claim(w);
        assert.notEqual(next.run, job.run);
        assert.equal(next.workspaceRun, first);
        assert.equal(next.session, session ?? null);
        job = next;
      }
    });
  }

  for (const when of ["before wake", "after enqueue"]) {
    test(`${kind} does not inherit another agent's session or workspace (${when})`, (t) => {
      const w = world(t);
      ingest(w, "first");
      const first = claim(w);
      defer(w, first, kind, "old-agent-session");
      if (when === "after enqueue") wake(w, kind);
      const config = structuredClone(w.view.get("config", "rules")!.value);
      config.rules[0].to = "b";
      w.call("rules", config);
      if (when === "before wake") wake(w, kind);
      const next: Job = w.call("claimNext", "w2", "new-agent");
      assert.equal(next.agent.id, "b");
      assert.equal(next.session, null);
      assert.equal(next.workspaceRun, next.run);
      assert.notEqual(next.workspaceRun, first.run);
    });
  }

  test(`${kind} joins queued events without losing its workspace`, (t) => {
    const w = world(t);
    ingest(w, "first");
    const first = claim(w);
    defer(w, first, kind, "session");
    ingest(w, "queued-before");
    wake(w, kind);
    ingest(w, "queued-after");
    const next = claim(w);
    assert.equal(next.context.events.length, 3);
    assert.equal(next.session, "session");
    assert.equal(next.workspaceRun, first.run);
  });

  for (const session of [undefined, "session"]) {
    test(`retry merges a queued ${kind} with its workspace (${session ?? "no session"})`, (t) => {
      const w = world(t);
      ingest(w, "first");
      const first = claim(w);
      defer(w, first, kind, session);
      ingest(w, "running");
      const running = claim(w);
      wake(w, kind);
      w.finish(running.run, { outcome: "failed" });
      w.restart();
      w.advance(5 * 60_000);
      const next = claim(w);
      assert.equal(next.run, running.run);
      assert.equal(next.session, session ?? null);
      assert.equal(next.workspaceRun, first.run);
      assert.equal(next.context.events.length, 2);
    });
  }

  test(`fixed-cwd ${kind} jobs keep the original shape`, (t) => {
    const w = world(t, false);
    ingest(w, "first");
    const first = claim(w);
    defer(w, first, kind, "session");
    wake(w, kind);
    const next = claim(w);
    assert.equal(next.session, "session");
    assert.deepEqual(next.rule, first.rule);
    assert.equal(Object.hasOwn(first, "workspaceRun"), false);
    assert.equal(Object.hasOwn(next, "workspaceRun"), false);
  });

  test(`legacy ${kind} rows remain readable after projection rebuild`, (t) => {
    const w = world(t);
    ingest(w, "first");
    const first = claim(w);
    defer(w, first, kind, "legacy-session");
    const log = structuredClone(w.log);
    for (const fact of log)
      for (const change of fact.changes) {
        if (!change.row) continue;
        delete change.row.workspace_run;
        if (change.table === "timers") delete change.row.agent;
      }
    const db = new DatabaseSync(":memory:");
    t.after(() => db.close());
    commit(db, openView(db, "old"), () => log);
    const saved = db.prepare("SELECT fact FROM facts ORDER BY seq").all();
    for (const format of ["old", "new"]) {
      const view = openView(db, format);
      assert.equal(jobOf(view, view.get("runs", first.run)!, environment).workspaceRun, first.run);
      const input = kind === "ask" ? { type: "answer", args: [1, { choice: 0 }] } : { type: "tick", args: [] };
      const decision = decide(view, input, 60_000, environment);
      // Inspect the decision without committing, so restart and rebuild see the same legacy log.
      const run = decision.facts
        .flatMap((f) => f.changes)
        .filter((c) => c.table === "runs")
        .at(-1)!.row!;
      assert.equal(run.workspace_run ?? run.id, kind === "ask" ? first.run : run.id);
      // Legacy timers have no recorded agent, so they keep the session they always resumed.
      assert.equal(run.resume, "legacy-session");
    }
    assert.deepEqual(db.prepare("SELECT fact FROM facts ORDER BY seq").all(), saved);
  });
}
