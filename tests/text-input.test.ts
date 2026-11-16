// Failure modes: text-only asks lack a usable label, accept a phantom recommendation/choice, drift between validators,
// render empty choice controls, accept a second or stale answer, or lose the original thread's text when resuming.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseResult } from "../protocol/validate.ts";
import { checkSchema } from "../protocol/schema.ts";
import { cardPage } from "../kernel/card-page.ts";
import { Conflict, InputError } from "../kernel/errors.ts";
import { render } from "../plugins/feishu/channel.ts";
import { World } from "../sim/world.ts";

const ask = { key: "words", title: "补充要求", text: "请填写要求", options: [], input: "具体要求" };

test("only an explicit valid input label permits zero options, with no recommendation", () => {
  const cases: [object, boolean][] = [
    [ask, true],
    [{ ...ask, input: "😀".repeat(20) }, true],
    ...[undefined, null, "", " ", 7, "😀".repeat(21)].map((input): [object, boolean] => [{ ...ask, input }, false]),
    ...[null, 0, -1, "0"].map((recommend): [object, boolean] => [{ ...ask, recommend }, false]),
    [{ ...ask, options: ["唯一选项"] }, false],
    [{ ...ask, options: ["甲", "乙"], input: undefined, recommend: 1 }, true],
    [{ ...ask, options: ["甲", "乙"], recommend: 2 }, false],
    [{ ...ask, options: ["甲", "乙", "丙", "丁", "戊"], recommend: 4 }, true],
    [{ ...ask, options: ["甲", "乙", "丙", "丁", "戊", "己"] }, false],
    [{ ...ask, options: undefined }, false],
  ];
  for (const [spec, valid] of cases) {
    const receipt = JSON.parse(JSON.stringify({ outcome: "done", ask: [spec] }));
    assert.equal(checkSchema("result", receipt).length === 0, valid, JSON.stringify(spec));
    if (valid) assert.doesNotThrow(() => parseResult(receipt));
    else assert.throws(() => parseResult(receipt), InputError);
  }
});

function submit(w: World, spec = ask) {
  w.call("ingest", "app", { id: `receipt-${w.view.seq}`, type: "one", subject: "#words" });
  const job = w.call("claimNext", "w1", `claim-${w.view.seq}`);
  w.finish(job.run, { outcome: "done", session: "words-session", ask: [spec] });
  return w.call("nextCard", "chat");
}

test("text-only asks expose one labelled versioned text form in Feishu and the card page", () => {
  const w = new World();
  try {
    const card = submit(w);
    assert.deepEqual(checkSchema("card", card), []);
    for (const patch of [{ input: null }, { input: undefined }, { recommend: 0 }, { options: ["唯一选项"] }]) {
      const value = JSON.parse(JSON.stringify({ ...card, ...patch }));
      assert.ok(checkSchema("card", value).length, JSON.stringify(patch));
    }
    const shown = render(card);
    const form = shown.body.elements.find((element) => element.tag === "form") as any;
    assert.deepEqual(
      shown.body.elements.map((element) => element.tag),
      ["markdown", "form"],
    );
    const row = form.elements[0];
    assert.equal(row.columns[0].elements[0].placeholder.content, ask.input);
    assert.deepEqual(row.columns[1].elements[0].behaviors, [
      { type: "callback", value: { card: card.id, text: true, version: card.version } },
    ]);
    assert.doesNotMatch(JSON.stringify(shown), /"choice"/);
    const page = cardPage(card);
    assert.equal(page.match(/<form /g)?.length, 1);
    assert.match(page, /name="text" placeholder="具体要求" aria-label="具体要求" required/);
    assert.match(page, /name="version" value="1"/);
    assert.doesNotMatch(page, /name="choice"/);
  } finally {
    w.view.close();
  }
});

test("text-only answers resume their thread once and reject old content versions after reopening", () => {
  const w = new World();
  try {
    const card = submit(w);
    w.call("delivered", "chat", card.id, card.version, "original-message");
    const answer = { channel: "chat", by: "owner", ref: "original-message", version: card.version };
    assert.throws(() => w.call("answer", card.id, { ...answer, choice: 0 }), InputError);
    assert.throws(() => w.call("answer", card.id, { ...answer, text: "  " }), InputError);
    assert.deepEqual(w.call("answer", card.id, { ...answer, text: "  保存原件  " }), {
      changed: true,
      state: "decided",
    });
    assert.deepEqual(w.call("answer", card.id, { ...answer, text: "第二次回答" }), {
      changed: false,
      state: "decided",
    });
    w.restart();
    const next = w.call("claimNext", "w1", "resume-words");
    assert.equal(next.session, "words-session");
    assert.deepEqual(
      next.context.answers.map((a: any) => [a.options, a.choice, a.text]),
      [[[], null, "保存原件"]],
    );
    w.finish(next.run, { outcome: "done", ask: [{ ...ask, text: "还要补充什么", continue: true }] });
    const update = w.call("nextCard", "chat");
    assert.equal(update.id, card.id);
    assert.equal(update.ref, "original-message");
    assert.throws(() => w.call("answer", card.id, { ...answer, text: "旧版本回答" }), Conflict);
    w.call("delivered", "chat", card.id, update.version, update.ref);
    w.call("answer", card.id, { ...answer, version: update.version, text: "还要备份" });
    const second = w.call("claimNext", "w1", "resume-again");
    assert.deepEqual(
      second.context.answers.map((a: any) => a.text),
      ["还要备份"],
    );
    assert.deepEqual(
      second.context.decided.map((a: any) => a.choice),
      ["保存原件"],
    );
  } finally {
    w.view.close();
  }
});
