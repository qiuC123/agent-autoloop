import assert from "node:assert/strict";
import { snapshot, type Fact, type View, type Row } from "../kernel/evolve.ts";
import type { Input } from "../kernel/decide.ts";

type Snapshot = ReturnType<typeof snapshot>;
const rows = (view: Snapshot, table: keyof Snapshot["tables"]) => Object.values(view.tables[table]);
// Independent replay oracle: it checks the indexed projection without using its write or query implementation.
export function replay(log: Fact[]): Snapshot {
  const tables = Object.fromEntries(
    ["events", "runs", "run_events", "cards", "deliveries", "timers", "schedules", "seen", "keys", "config", "due"].map(
      (t) => [t, {}],
    ),
  ) as Snapshot["tables"];
  const next: Record<string, number> = {};
  let seq = 0;
  for (const fact of log) {
    seq = fact.seq;
    for (const { table, key, row } of fact.changes) {
      if (row === null) delete tables[table][key];
      else {
        tables[table][key] = table === "cards" ? { content_version: 1, input: null, ...row } : row;
        // Configuration versions are derived from each rules fact, including logs written before the lookup existed.
        if (table === "config" && key === "rules") tables.config[String(row.version)] = row;
        if (typeof row.id === "number") next[table] = Math.max(next[table] ?? 0, row.id);
      }
    }
  }
  return { seq, tables, next };
}
export function invariants(current: View, log: Fact[], before?: Snapshot, input?: Input) {
  const view = snapshot(current);
  assert.deepEqual(view, replay(log), "日志重放记录不同");
  for (const [index, fact] of log.entries()) assert.equal(fact.seq, index + 1, "日志序号不连续");
  const events = rows(view, "events");
  const runs = rows(view, "runs");
  const cards = rows(view, "cards");
  const links = rows(view, "run_events");
  assert.equal(new Set(events.map((e) => JSON.stringify([e.source, e.key]))).size, events.length, "重复事件");
  const held = runs.filter((r) => r.state === "claimed");
  assert.equal(new Set(held.map((r) => JSON.stringify([r.grp, r.lane]))).size, held.length, "同一事项同时领了两轮");
  for (const group of new Set(held.map((r) => r.grp)))
    assert.ok(
      held.filter((r) => r.grp === group).length <=
        (view.tables.config.rules.value.rules.find((r: Row) => r.group === group)?.parallel ?? 1),
      "超出同组并发数",
    );
  for (const e of events)
    for (const rule of JSON.parse(e.routed))
      assert.ok(
        links.some((l) => l.event_id === e.id && view.tables.runs[l.run_id]?.rule === rule),
        "已收事件丢了派发关系",
      );
  for (const card of cards)
    if (card.answer_event !== null) {
      const event = view.tables.events[card.answer_event];
      assert.equal(event?.type, "card.answered");
      if (view.tables.config.rules.value.rules.some((r: Row) => r.name === card.rule))
        assert.ok(
          links.some(
            (l) =>
              l.event_id === card.answer_event &&
              view.tables.runs[l.run_id]?.rule === card.rule &&
              view.tables.runs[l.run_id]?.lane === card.lane,
          ),
          "回答没叫醒原事项",
        );
    }
  if (before) {
    if (input?.type === "answer") {
      const [id, given] = input.args;
      const old: Row | undefined = before.tables.cards[id];
      const accepted = old?.state === "open" && view.tables.cards[id]?.state !== "open";
      if (accepted)
        assert.ok(given.version === undefined || given.version >= old.content_version, "接受了旧内容的回答");
    }
    for (const card of cards) {
      assert.ok(card.content_version >= 1 && card.content_version <= card.version, "内容版本越界");
      const old: Row | undefined = before.tables.cards[card.id];
      if (!old) continue;
      const changed = ["title", "text", "options", "recommend", "about", "input"].some((key) => old[key] !== card[key]);
      if (changed && !card.fyi) {
        assert.equal(card.version, old.version + 1, "内容改变没有递增版本");
        assert.equal(card.content_version, card.version, "内容版本没有跟随更新");
      }
    }
    for (const card of cards.filter((c) => c.kind === "ask" && !before.tables.cards[c.id]))
      assert.notEqual(
        before.tables.config.rules?.value.rules.find((r: Row) => r.name === card.rule)?.ask,
        false,
        "禁止提问的规则建了 ask 卡片",
      );
    for (const e of rows(before, "events")) assert.deepEqual(view.tables.events[e.id], e, "已落盘事件被改了或丢了");
    for (const c of rows(before, "cards"))
      if (c.answer_event !== null) {
        const now = view.tables.cards[c.id];
        assert.equal(now.answer_event, c.answer_event);
        assert.equal(now.choice, c.choice);
        assert.equal(now.answer, c.answer);
      }
    for (const r of rows(before, "runs"))
      if (["done", "nothing", "cancelled"].includes(r.state))
        assert.deepEqual(view.tables.runs[r.id], r, "完成的回执再次生效");
  }
  return view;
}
