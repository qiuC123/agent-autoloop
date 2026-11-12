import assert from "node:assert/strict";
import { snapshot, type Fact, type View, type Row } from "../kernel/evolve.ts";
import type { Input } from "../kernel/decide.ts";
import { cardView } from "../kernel/query.ts";

type Snapshot = ReturnType<typeof snapshot>;
const rows = (view: Snapshot, table: keyof Snapshot["tables"]) => Object.values(view.tables[table]);
// Independent replay oracle: it checks the indexed projection without using its write or query implementation.
export function replay(log: Fact[]): Snapshot {
  const tables = Object.fromEntries(
    [
      "events",
      "runs",
      "run_events",
      "cards",
      "answers",
      "deliveries",
      "timers",
      "schedules",
      "seen",
      "keys",
      "config",
      "due",
    ].map((t) => [t, {}]),
  ) as Snapshot["tables"];
  const next: Record<string, number> = {};
  let seq = 0;
  for (const fact of log) {
    seq = fact.seq;
    for (const { table, key, row } of fact.changes) {
      if (table === "cards" && row?.answer_event != null)
        tables.answers[row.answer_event] ??= { ...row, id: row.answer_event, card_id: row.id };
      if (table === "cards" && row === null)
        for (const answer of Object.values(tables.answers))
          if (String(answer.card_id) === key) delete tables.answers[answer.id];
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
  for (const card of cards.filter((c) => c.fyi)) {
    assert.equal(card.state, "closed", "只告知的卡片不能变成待办");
    assert.equal(card.kind, "notice");
    assert.deepEqual(
      cardView(card, { secret: "simulation", publicUrl: "https://hub.test" }).options,
      [],
      "只告知的卡片不能有按钮",
    );
    assert.equal(card.answer_event, null, "只告知的卡片不能唤醒事项");
  }
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
  for (const card of rows(view, "answers")) {
    const event = view.tables.events[card.id];
    assert.equal(event?.type, "card.answered");
    if (view.tables.config.rules.value.rules.some((r: Row) => r.name === card.rule))
      assert.ok(
        links.some(
          (l) =>
            l.event_id === card.id &&
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
      if (old?.state !== "open") assert.deepEqual(view.tables.cards[id], old, "同一轮开放期接受了重复回答");
      const accepted = old?.state === "open" && view.tables.cards[id]?.state !== "open";
      if (accepted)
        assert.ok(given.version === undefined || given.version >= old.content_version, "接受了旧内容的回答");
    }
    for (const card of cards) {
      assert.ok(card.content_version >= 1 && card.content_version <= card.version, "内容版本越界");
      const old: Row | undefined = before.tables.cards[card.id];
      if (!old) continue;
      const changed =
        ["kind", "fyi", "title", "text", "options", "recommend", "about", "input"].some(
          (key) => old[key] !== card[key],
        ) ||
        (old.state !== "open" && card.state === "open");
      if (changed && (!card.fyi || input?.type === "finish")) {
        const explicitResolve: boolean = Boolean(
          input?.type === "finish" &&
          input.args[2]?.resolve?.some((r: Row) => r.card === card.id) &&
          old.state === "open",
        );
        assert.equal(card.version, old.version + (explicitResolve ? 2 : 1), "内容改变没有递增版本");
        assert.equal(card.content_version, card.version, "内容版本没有跟随更新");
        for (const key of [
          "id",
          "key",
          "created_at",
          "rule",
          "lane",
          "grp",
          "source",
          "agent",
          "session",
          "workspace_run",
          "run_id",
        ])
          assert.equal(card[key], old[key], "续用改变了卡片归属");
        for (const delivery of rows(before, "deliveries").filter((d) => d.card_id === card.id)) {
          const updated = view.tables.deliveries[`${card.id}:${delivery.channel}`];
          assert.equal(updated.ref, delivery.ref, "续用丢了通道原消息");
          assert.deepEqual([updated.tries, updated.given_up, updated.error], [0, 0, null], "续用没有重置投递");
        }
      }
    }
    for (const card of cards.filter(
      (c) =>
        c.kind === "ask" &&
        (!before.tables.cards[c.id] || c.content_version !== before.tables.cards[c.id].content_version),
    ))
      assert.notEqual(
        before.tables.config.rules?.value.rules.find((r: Row) => r.name === card.rule)?.ask,
        false,
        "禁止提问的规则建了 ask 卡片",
      );
    for (const e of rows(before, "events")) assert.deepEqual(view.tables.events[e.id], e, "已落盘事件被改了或丢了");
    for (const answer of rows(before, "answers"))
      assert.deepEqual(view.tables.answers[answer.id], answer, "旧回答被改了或丢了");
    for (const r of rows(before, "runs"))
      if (["done", "nothing", "cancelled"].includes(r.state))
        assert.deepEqual(view.tables.runs[r.id], r, "完成的回执再次生效");
  }
  return view;
}
