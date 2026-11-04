import { World } from "./world.ts";
import assert from "node:assert/strict";
import { Conflict } from "../kernel/errors.ts";
export function enumerate() {
  let paths = 0;
  let transitions = 0;
  const visit = (order: number[], left: number[]) => {
    if (left.length) {
      for (const n of left)
        visit(
          [...order, n],
          left.filter((x) => x !== n),
        );
      return;
    }
    const world = new World();
    const jobs = new Map<number, number>();
    world.call("createCard", {
      key: "question",
      kind: "ask",
      title: "选一个",
      text: "内容",
      options: ["甲", "乙"],
      rule: "one",
      lane: "#1",
      grp: "shared",
      source: "app",
    });
    for (const n of order) {
      if (n < 2) world.call("ingest", "app", { id: String(n), type: n ? "two" : "one", subject: `#${n + 1}` });
      else if (n < 4) {
        const job = world.call("claimNext", n === 2 ? "w1" : "w2", `c${n}`);
        if (job) jobs.set(n - 2, job.run);
      } else if (n < 6) {
        const id = jobs.get(n - 4);
        if (id) world.finish(id);
        else world.call("tick");
      } else if (n === 6) world.call("answer", 1, { choice: 0 });
      else world.call("resolve", 1, "核实完成", "本人");
    }
    world.recover();
    transitions += world.transitions;
    world.view.close();
    paths++;
  };
  visit(
    [],
    Array.from({ length: 8 }, (_, i) => i),
  );
  return { paths, transitions, actions: 8, workers: 2, events: 2, cards: 1 };
}
if (import.meta.main) console.log(JSON.stringify({ scheduling: enumerate(), cards: enumerateCards() }, null, 2));

export function enumerateCards() {
  let paths = 0;
  let transitions = 0;
  const visit = (order: number[], left: number[]) => {
    if (left.length) {
      for (const n of left)
        visit(
          [...order, n],
          left.filter((x) => x !== n),
        );
      return;
    }
    const world = new World();
    const ask = { key: "question", title: "选", text: "原文", options: ["甲", "乙"] };
    const submit = (text: string) => {
      world.call("ingest", "app", { id: `revision-${world.transitions}`, type: "one", subject: "#1" });
      const job = world.call("claimNext", "w1", `revision-${world.transitions}`);
      world.finish(job.run, { outcome: "done", ask: [{ ...ask, text }] });
    };
    submit("原文");
    for (const n of order) {
      if (n === 0) submit("新内容");
      else if (n === 1) {
        const old = () => world.call("answer", 1, { choice: 0, version: 1 });
        if (world.view.get("cards", 1)!.content_version > 1) assert.throws(old, Conflict);
        else old();
      } else if (n === 2) world.call("answer", 1, { text: "意见", version: world.view.get("cards", 1)!.version });
      else if (n === 3) world.call("resolve", 1, "不用了", "owner");
      else if (n === 6) world.restart();
      else {
        const channel = n === 4 ? "chat" : "plain";
        const card = world.call("nextCard", channel);
        if (card) world.call("delivered", channel, card.id, card.version, `${channel}-${card.id}`);
      }
    }
    world.recover();
    transitions += world.transitions;
    world.view.close();
    paths++;
  };
  visit(
    [],
    Array.from({ length: 7 }, (_, i) => i),
  );
  return { paths, transitions, actions: 7, channels: 2 };
}
