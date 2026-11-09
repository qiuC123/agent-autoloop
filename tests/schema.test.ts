// Failure modes: published schemas accept an impersonated source, malformed receipts, or credentials in event data;
// the wire contract drifts from the validators, and conformance accepts a server that opens the wrong door.
// Required job structure and inherited object names must not bypass schema checks; Unicode limits count code points.
// Input labels must agree with receipt validation and answer versions must be positive safe integers.
// The optional job.rule.ask permission must remain boolean on the wire.
// Workspace mode must remain restricted to run, with positive workspace IDs on the wire.
// A truthy non-boolean FYI flag must not silently hide an actionable notice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSchema } from "../protocol/schema.ts";
import { parseEvent, parseResult } from "../protocol/validate.ts";

test("notice fyi is optional and strictly boolean in both validators", () => {
  for (const fyi of [undefined, false, true, null, 0, 1, "true", [], {}]) {
    const result = {
      outcome: "done",
      notice: [{ title: "进度", text: "已交出", ...(fyi === undefined ? {} : { fyi }) }],
    };
    const valid = fyi === undefined || typeof fyi === "boolean";
    assert.equal(checkSchema("result", result).length === 0, valid);
    if (valid) assert.doesNotThrow(() => parseResult(result));
    else assert.throws(() => parseResult(result));
  }
  const card = {
    id: 1,
    version: 1,
    kind: "notice",
    state: "closed",
    title: "进度",
    text: "已交出",
    options: [],
    ref: null,
    recommend: null,
    choice: null,
    answer: null,
    by: null,
    result: null,
    link: null,
    fyi: true,
  };
  assert.deepEqual(checkSchema("card", card), []);
  for (const invalid of [
    { fyi: "true" },
    { state: "open" },
    { options: ["已处理"] },
    { kind: "ask", options: ["甲", "乙"] },
  ])
    assert.ok(checkSchema("card", { ...card, ...invalid }).length);
});

test("input labels accept up to 20 code points and answer versions are optional positive safe integers", () => {
  for (const input of [undefined, "返工意见", "😀".repeat(20), "", " ", "😀".repeat(21), null, 7]) {
    const valid = input === undefined || (typeof input === "string" && input.trim() !== "" && [...input].length <= 20);
    const result = {
      outcome: "done",
      ask: [{ title: "选", text: "内容", options: ["甲", "乙"], ...(input !== undefined && { input }) }],
    };
    assert.equal(checkSchema("result", result).length === 0, valid);
    if (valid) assert.doesNotThrow(() => parseResult(result));
    else assert.throws(() => parseResult(result));
  }
  for (const version of [undefined, 1, 7, 0, -1, 1.1, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    const valid = version === undefined || (Number.isSafeInteger(version) && Number(version) > 0);
    assert.equal(checkSchema("answer", { choice: 0, ...(version !== undefined && { version }) }).length === 0, valid);
  }
});

test("job schemas accept an omitted or boolean ask permission, not other values", () => {
  const job = {
    run: 1,
    token: "t",
    attempt: 1,
    session: null,
    askFirst: [],
    rule: { name: "rule", cwd: "/work" },
    agent: { id: "a", name: "Agent", use: "command", access: "read" },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
  assert.deepEqual(checkSchema("job", job), []);
  for (const workspaceRun of [1, 7, 0, -1, 1.1, "1", null]) {
    assert.deepEqual(
      checkSchema("job", { ...job, workspaceRun }),
      Number.isInteger(workspaceRun) && Number(workspaceRun) > 0 ? [] : ["job.workspaceRun"],
    );
  }
  for (const workspace of ["run", null, "thread", false, 1, [], {}]) {
    assert.deepEqual(
      checkSchema("job", { ...job, rule: { ...job.rule, workspace } }),
      workspace === "run" ? [] : ["job.rule.workspace"],
    );
  }

  for (const ask of [false, true, null, "false", 0, [], {}]) {
    assert.deepEqual(
      checkSchema("job", { ...job, rule: { ...job.rule, ask } }),
      typeof ask === "boolean" ? [] : ["job.rule.ask"],
    );
  }
});

test("wire schemas agree with event and receipt boundaries", () => {
  for (const input of [
    { id: "one", type: "app.changed" },
    { id: " ", type: "app.changed", summary: null },
    { id: "one", type: "app.changed", source: "other" },
    { id: 7, type: "invalid" },
    { id: "one", type: "bad type" },
  ]) {
    let accepted = true;
    try {
      parseEvent(input);
    } catch {
      accepted = false;
    }
    assert.equal(checkSchema("event", input).length === 0, accepted);
  }
  for (const input of [
    { outcome: "done" },
    { outcome: "done", events: [{ id: "x", type: "app.changed" }] },
    { outcome: "unknown" },
    { outcome: "done", ask: [{ title: "选", text: "内容", options: ["一"] }] },
    { outcome: "done", ask: [{ title: "选", text: "内容", options: ["一", "二"], recommend: 2 }] },
    { outcome: "done", later: [{ key: "k", at: "badZ", about: "后来" }] },
  ]) {
    let accepted = true;
    try {
      parseResult(input);
    } catch {
      accepted = false;
    }
    assert.equal(checkSchema("result", input).length === 0, accepted);
  }
});

test("schema checks reject inherited names and incomplete tasks or question cards", () => {
  assert.ok(checkSchema("event", { id: "x", type: "one", constructor: "unexpected" }).length);
  assert.ok(checkSchema("job", { run: 1, token: "t", rule: {}, agent: {}, context: {} }).length);
  assert.ok(
    checkSchema("card", { id: 1, version: 1, kind: "ask", state: "open", title: "选", text: "内容", options: [] })
      .length,
  );
  assert.throws(() => checkSchema("constructor", {}));
});

test("published text limits count Unicode characters, including astral code points", () => {
  const event = { id: "x", type: "one", summary: "😀".repeat(200) };
  assert.deepEqual(checkSchema("event", event), []);
  assert.equal(parseEvent(event).summary, event.summary);
  assert.deepEqual(checkSchema("tell-source", { key: "unicode", text: "😀".repeat(20000) }), []);
  const receipt = { outcome: "done", summary: "😀".repeat(500) };
  assert.deepEqual(checkSchema("result", receipt), []);
  assert.equal(parseResult(receipt).summary, receipt.summary);
});

test("usage must be an object of finite nonnegative amounts", () => {
  for (const usage of [[1], { cost: -1 }, { cost: Infinity }, { input: NaN }]) {
    assert.throws(() => parseResult({ outcome: "done", usage }));
    assert.ok(checkSchema("result", { outcome: "done", usage }).length);
  }
});

test("timer timestamps are real calendar dates in the documented ISO format", () => {
  for (const at of ["2000Z", "2026-02-30T10:00:00Z", "2026-01-01T25:00:00Z"]) {
    const result = { outcome: "done", later: [{ key: "later", at, about: "再查" }] };
    assert.throws(() => parseResult(result));
    assert.ok(checkSchema("result", result).length);
  }
  const result = { outcome: "done", later: [{ key: "later", at: "2028-02-29T10:00:00+08:00", about: "再查" }] };
  assert.doesNotThrow(() => parseResult(result));
  assert.deepEqual(checkSchema("result", result), []);
});
