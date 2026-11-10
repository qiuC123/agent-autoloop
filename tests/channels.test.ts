// The channels that ship and the webhook adapter. No real listener runs here: only one can hold an app's card clicks.
// Failure cases: a first send uses a key that changes with the version, or an update sends a new message; a failed send
// isn't reported; a click that isn't a card's is taken; a card's options don't show while it's open or still show after;
// the listener dying isn't started again. A GitHub webhook with a bad signature, or with none, is taken; what isn't an
// identifier reaches the subject; a ping makes an event; replacement tokens in card text rewrite a webhook template.
// A slow CLI call must not block the hub's HTTP loop while looking up a user, sending or updating a card.
// Text submits must use form_value; stale answers must notify at the original message without patching the card.
// FYIs must render only information, without any callback, form or acknowledgement button.
// Short choices must stay compact without losing recommendation or callback values; long choices must still wrap.
// The required text field and submit must share a row without a separate label.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import feishu, { render } from "../plugins/feishu/channel.ts";
import webhook from "../plugins/webhook/channel.ts";
import github from "../plugins/github/source.ts";
import type { Card } from "../host/channels.ts";
import { HubError } from "../protocol/client.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-channels-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const base: Card = {
  id: 5,
  version: 1,
  content_version: 1,
  input: null,
  ref: null,
  kind: "ask",
  state: "open",
  title: "要不要删",
  text: "占了 10 GB",
  options: ["删", "留着"],
  recommend: 1,
  choice: null,
  answer: null,
  result: null,
  link: "https://hub.test/c/x",
};

test("a card shows its options while it's open, and what became of it after", () => {
  const open = render(base);
  const rows = open.body.elements.filter((e) => e.tag === "column_set") as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].flex_mode, "none");
  assert.equal(rows[0].columns.length, 2);
  rows[0].columns.forEach((column: any, index: number) => {
    assert.equal(column.tag, "column");
    assert.equal(column.width, "weighted");
    assert.equal(column.weight, 1);
    assert.equal(column.vertical_align, "center");
    assert.equal(column.elements.length, 1);
    const button = column.elements[0];
    assert.equal(button.tag, "button");
    assert.deepEqual(button.text, { tag: "plain_text", content: base.options[index] });
    assert.equal(button.width, "fill");
    assert.equal(button.type, index === base.recommend ? "primary" : "default");
    assert.deepEqual(button.behaviors, [{ type: "callback", value: { card: 5, choice: index, version: 1 } }]);
  });
  const said = (card: Card) => JSON.stringify(render(card).body.elements);
  assert.match(said({ ...base, state: "decided", choice: 1 }), /你选了「留着」，已记录/);
  assert.ok(!said({ ...base, state: "decided", choice: 1 }).includes("callback"));
  assert.match(said({ ...base, state: "done", choice: 0, result: "删了" }), /你选了「删」。已执行：删了/);
  assert.match(said({ ...base, state: "decided", answer: "归档" }), /你选了「归档」/);
  assert.match(said({ ...base, state: "closed", result: "问题自己好了" }), /不用决定了：问题自己好了/);
  assert.match(said({ ...base, kind: "notice", state: "closed", options: [], result: "已处理" }), /已处理/);
});

test("short choices wrap after three columns and default to the first recommendation", () => {
  for (const count of [3, 4, 6, 7, 8]) {
    const options = Array.from({ length: count }, (_, i) => `选${i}`);
    const rows = render({ ...base, options, recommend: null }).body.elements.filter(
      (e) => e.tag === "column_set",
    ) as any[];
    assert.equal(rows.length, Math.ceil(count / 3));
    rows.forEach((row, index) => {
      assert.equal(row.flex_mode, "none");
      assert.equal(row.columns.length, Math.min(3, count - index * 3));
    });
    const buttons = rows.flatMap((row) => row.columns.map((column: any) => column.elements[0]));
    assert.deepEqual(
      buttons.map((button) => button.text.content),
      options,
    );
    buttons.forEach((button, index) => {
      assert.equal(button.type, index === 0 ? "primary" : "default");
      assert.deepEqual(button.behaviors, [{ type: "callback", value: { card: 5, choice: index, version: 1 } }]);
    });
  }
});

test("choice length counts code points and long choices keep full-width bordered blocks", () => {
  const short = render({ ...base, options: ["😀".repeat(8)] });
  assert.ok(short.body.elements.some((e) => e.tag === "column_set"));
  const options = ["删", "😀".repeat(9)];
  const shown = render({ ...base, options });
  const blocks = shown.body.elements.filter((e) => e.tag === "interactive_container") as any[];
  assert.equal(blocks.length, 2);
  assert.ok(!shown.body.elements.some((e) => e.tag === "column_set"));
  blocks.forEach((block, index) => {
    assert.equal(block.width, "fill");
    assert.equal(block.has_border, true);
    assert.equal(block.border_color, index === base.recommend ? "blue" : "grey");
    assert.equal(block.elements[0].text.content, options[index]);
    assert.deepEqual(block.behaviors, [{ type: "callback", value: { card: 5, choice: index, version: 1 } }]);
  });
});

test("FYIs render as text without any interaction, including content updates", () => {
  for (const version of [1, 2]) {
    const card = { ...base, kind: "notice" as const, state: "closed" as const, fyi: true, options: [], version };
    const shown = JSON.stringify(render(card));
    assert.ok(shown.includes(card.text));
    assert.doesNotMatch(shown, /callback|button|form|input|interactive_container|已处理|不用决定/);
  }
});

test("open questions have a compact named form with a versioned submit and an unlabelled required input", () => {
  for (const input of [null, '返工意见"<>']) {
    const card = render({ ...base, version: 3, input });
    const form = card.body.elements.find((e) => e.tag === "form") as any;
    assert.ok(form);
    assert.equal(form.name, "answer_form");
    assert.equal(form.elements.length, 1);
    const row = form.elements[0];
    assert.equal(row.tag, "column_set");
    assert.equal(row.flex_mode, "none");
    assert.equal(row.columns.length, 2);
    assert.deepEqual(
      row.columns.map((column: any) => column.width),
      ["weighted", "weighted"],
    );
    assert.deepEqual(
      row.columns.map((column: any) => column.weight),
      [4, 1],
    );
    assert.equal(row.columns[1].vertical_align, "center");
    const field = row.columns[0].elements.find((e: any) => e.tag === "input");
    assert.equal(field.name, "answer_text");
    assert.equal(field.required, true);
    assert.ok(!Object.hasOwn(field, "label"));
    assert.deepEqual(field.placeholder, { tag: "plain_text", content: input ?? "别的想法" });
    const submit = row.columns[1].elements.find((e: any) => e.tag === "button");
    assert.equal(submit.name, "answer_submit");
    assert.equal(submit.width, "fill");
    assert.deepEqual(submit.text, { tag: "plain_text", content: "发送" });
    assert.equal(submit.form_action_type, "submit");
    assert.deepEqual(submit.behaviors, [{ type: "callback", value: { card: 5, text: true, version: 3 } }]);
  }
  for (const card of [
    { ...base, kind: "notice" },
    ...["decided", "done", "closed"].map((state) => ({ ...base, state })),
  ])
    assert.ok(!render(card as Card).body.elements.some((e) => e.tag === "form"));
});

test(
  "feishu reads form submissions and replies only to stale clicks, never resending the card",
  { timeout: 10000 },
  async () => {
    const lark = join(dir, "form-lark");
    const logFile = join(dir, "form-lark.log");
    const event = (value: object, form?: unknown) => ({
      action_value: JSON.stringify(value),
      form_value: form === undefined ? "" : JSON.stringify(form),
      operator_id: "ou_me",
      message_id: "om_5",
    });
    const events = [
      event({ card: 5, text: true, version: 2 }, { answer_text: "改成归档" }),
      event({ card: 5, text: true, version: 1 }, { answer_text: "旧想法" }),
      event({ card: 5, choice: 0, version: 1 }),
      { ...event({ card: 5, choice: 0, version: 2 }), operator_id: "intruder" },
      event({ card: 5, text: true, version: 2 }, { answer_text: 12 }),
      event({ card: 5, text: true, version: 2 }, { answer_text: " " }),
      event({ card: 5, text: true, version: 2 }, {}),
      event({ other: 1 }),
    ];
    writeFileSync(
      lark,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'event') {
  for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));
  setInterval(() => {}, 1000);
} else {
  fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\\n');
  process.stdin.resume();
  process.stdin.on('end', () => console.log(JSON.stringify({ ok: true })));
}
`,
      { mode: 0o755 },
    );
    const stop = new AbortController();
    const calls: any[] = [];
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const timeout = setTimeout(() => {
      stop.abort();
      complete();
    }, 5000);
    const logs: string[] = [];
    const hub = {
      async nextCard() {
        await done;
        stop.abort();
        return { card: null };
      },
      async answer(id: number, body: any) {
        calls.push([id, body]);
        if (body.by === "intruder") throw new HubError(401, "这个人不能回答这张卡片");
        if (body.version === 1) throw new HubError(409, "卡片已更新，请重看");
        return { changed: true };
      },
    };
    try {
      await feishu({
        hub: hub as any,
        options: { user: "ou_me", lark },
        signal: stop.signal,
        log: (line) => {
          logs.push(line);
          if (logs.length === 4) complete();
        },
      });
      assert.equal(calls.length, 4);
      assert.deepEqual(calls[0], [5, { text: "改成归档", version: 2, by: "ou_me", ref: "om_5" }]);
      const commands = readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        commands,
        Array.from({ length: 2 }, () => [
          "im",
          "+messages-reply",
          "--message-id",
          "om_5",
          "--as",
          "bot",
          "--text",
          "卡片已更新，请重看",
        ]),
      );
      assert.ok(logs.some((line) => line.includes("401") || line.includes("不能回答")));
    } finally {
      clearTimeout(timeout);
      stop.abort();
    }
  },
);

test("feishu CLI calls leave the HTTP loop available", async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const lark = join(dir, "async-lark");
  writeFileSync(
    lark,
    `#!${process.execPath}
if (process.argv[2] === 'event') { setInterval(() => {}, 1000); }
else {
  (async () => {
    if (process.argv[2] !== 'auth') for await (const chunk of process.stdin) {}
    await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(2000) });
    console.log(JSON.stringify({ ok: true, identities: { user: { openId: 'ou_me' } }, data: { message_id: 'om_5' } }));
  })().catch(() => process.exit(1));
}
`,
    { mode: 0o755 },
  );
  const stop = new AbortController();
  const cards = [base, { ...base, version: 2, ref: "om_5" }];
  let delivered = 0;
  const failed: unknown[] = [];
  const hub = {
    async nextCard() {
      const card = cards.shift() ?? null;
      if (!card) stop.abort();
      return { card };
    },
    async delivered() {
      delivered++;
    },
    async failed(...args: unknown[]) {
      failed.push(args);
    },
  };
  try {
    await feishu({ hub: hub as any, options: { lark }, log: () => {}, signal: stop.signal });
    assert.deepEqual(failed, []);
    assert.equal(delivered, 2);
    assert.equal(requests, 3, "user lookup, send and patch each allowed HTTP to respond");
  } finally {
    stop.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("feishu: sends once per card, updates in place, reports failure, and only real clicks count", async () => {
  const log = join(dir, "lark.log");
  const lark = join(dir, "lark-cli");
  // A stand-in for lark-cli: records each call; `event consume` prints two clicks and waits to be stopped.
  writeFileSync(
    lark,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');
if (args[0] === 'event') {
  console.log(JSON.stringify({action_value:JSON.stringify({card:5,choice:1}),operator_id:'ou_me',message_id:'om_5'}));
  console.log(JSON.stringify({action_value:JSON.stringify({other:1}),operator_id:'ou_me',message_id:'om_5'}));
  setInterval(() => {}, 1000);
} else {
  let input = '';
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    if (input.includes('fail-me')) process.exit(1);
    console.log(JSON.stringify({ok:true,data:{message_id:'om_5'}}));
  });
}
`,
    { mode: 0o755 },
  );
  const stop = new AbortController();
  const cards: (Card | null)[] = [
    base,
    { ...base, version: 2, ref: "om_5", state: "decided", choice: 1 },
    { ...base, id: 6, title: "fail-me", ref: null },
  ];
  const calls: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      await new Promise((resolve) => setTimeout(resolve, 150));
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      calls.push(["delivered", ...args]);
      return {};
    },
    async failed(...args: unknown[]) {
      calls.push(["failed", args[0], args[1]]);
      return {};
    },
    async answer(...args: unknown[]) {
      calls.push(["answer", ...args]);
      return { changed: true };
    },
  };
  await feishu({ hub: hub as any, options: { user: "ou_me", lark }, log: () => {}, signal: stop.signal });
  const lines = readFileSync(log, "utf8").trim().split("\n");
  const sends = lines.filter((l) => l.includes("+messages-send"));
  assert.ok(sends[0].includes("--idempotency-key agent-autoloop-card-5"), "the key doesn't change with the version");
  assert.ok(sends[0].includes("--user-id ou_me"));
  assert.ok(
    lines.some((l) => l.includes("messages patch --message-id om_5")),
    "an update changes the message that was sent",
  );
  assert.deepEqual(
    calls.find((c) => c[0] === "delivered" && c[2] === 1),
    ["delivered", 5, 1, "om_5"],
  );
  assert.deepEqual(
    calls.find((c) => c[0] === "delivered" && c[2] === 2),
    ["delivered", 5, 2, "om_5"],
  );
  assert.deepEqual(
    calls.find((c) => c[0] === "failed"),
    ["failed", 6, 1],
  );
  assert.deepEqual(
    calls.filter((c) => c[0] === "answer"),
    [["answer", 5, { choice: 1, by: "ou_me", ref: "om_5" }]],
  );
});

test("a webhook channel posts words and the link once, and has nothing to do for an update", async () => {
  const seen: any[] = [];
  const target = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => {
      text += c;
    });
    req.on("end", () => {
      seen.push(JSON.parse(text));
      res.statusCode = seen.length === 2 ? 500 : 200;
      res.end();
    });
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const stop = new AbortController();
  const literal = '$& $` $\' {text} "},"admin":true';
  const cards: Card[] = [
    { ...base, text: literal },
    { ...base, version: 2, ref: "sent-5", state: "decided", choice: 0 },
    { ...base, id: 7 },
    { ...base, id: 8, kind: "notice", state: "closed", fyi: true, options: [], title: "进度", text: "已交出" },
    { ...base, id: 8, kind: "notice", state: "closed", fyi: true, options: [], version: 2, ref: "sent-8" },
  ];
  const calls: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      calls.push(["delivered", ...args]);
      return {};
    },
    async failed(...args: unknown[]) {
      calls.push(["failed", args[0], args[1]]);
      return {};
    },
    async answer() {
      return {};
    },
  };
  await webhook({
    hub: hub as any,
    options: {
      url: `http://127.0.0.1:${(target.address() as AddressInfo).port}`,
      body: { msgtype: "text", text: { content: "{text}" } },
    },
    log: () => {},
    signal: stop.signal,
  });
  target.close();
  assert.equal(seen.length, 3);
  assert.equal(seen[2].text.content, "进度\n\n已交出");
  assert.equal(seen[0].text.content, `${base.title}\n\n${literal}\n\n1. 删\n2. 留着\n\n${base.link}`);
  assert.match(seen[0].text.content, /要不要删[\s\S]*1\. 删[\s\S]*https:\/\/hub\.test\/c\/x/);
  assert.deepEqual(calls, [
    ["delivered", 5, 1, "sent-5"],
    ["delivered", 5, 2, "sent-5"],
    ["failed", 7, 1],
    ["delivered", 8, 1, "sent-8"],
    ["delivered", 8, 2, "sent-8"],
  ]);
});

test("GitHub: signed or not taken, and what it says becomes a plain event", () => {
  const secret = "s3cret";
  const body = JSON.stringify({
    action: "opened",
    issue: { number: 12, title: "首页打不开", body: "详情", html_url: "https://github.com/a/b/issues/12" },
    repository: { full_name: "a/b", html_url: "https://github.com/a/b" },
  });
  const headers = (b: string, over: object = {}) => ({
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(b).digest("hex")}`,
    "x-github-event": "issues",
    "x-github-delivery": "d-1",
    ...over,
  });
  assert.deepEqual(github({ headers: headers(body), body, secret }), [
    {
      id: "d-1",
      type: "issues.opened",
      subject: "a/b#12",
      summary: "首页打不开",
      detail: "详情",
      link: "https://github.com/a/b/issues/12",
    },
  ]);
  assert.throws(() => github({ headers: headers(body, { "x-hub-signature-256": "sha256=00" }), body, secret }));
  assert.throws(() => github({ headers: { "x-github-event": "issues" }, body, secret }));
  assert.throws(() => github({ headers: headers(body), body, secret: "" }), "no secret set up takes nothing");
  assert.deepEqual(github({ headers: headers("{}", { "x-github-event": "ping" }), body: "{}", secret }), []);
  const odd = JSON.stringify({ repository: { full_name: "a/b c" } });
  assert.match(
    (github({ headers: headers(odd, { "x-github-event": "push" }), body: odd, secret }) as any)[0].subject,
    /^a\/b-c$/,
  );
});
