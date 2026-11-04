// Prevents login services from losing custom rules, retaining stale overrides, or interpreting path characters as syntax.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const directory = mkdtempSync(path.join(tmpdir(), "agent-autoloop-service-config-"));
process.env.AGENT_AUTOLOOP_HOME = directory;
after(() => rmSync(directory, { recursive: true, force: true }));
const { plist, unit } = await import("../host/service.ts");

for (const [name, generate] of [
  ["launchd", plist],
  ["systemd", unit],
] as const) {
  test(`${name} captures absolute rules and regenerates without stale overrides`, () => {
    const previous = process.env.AGENT_AUTOLOOP_RULES;
    try {
      for (const rules of [
        undefined,
        "./规则 & space/custom.json",
        path.join(directory, "更新 rules.json"),
        undefined,
      ]) {
        if (rules === undefined) delete process.env.AGENT_AUTOLOOP_RULES;
        else process.env.AGENT_AUTOLOOP_RULES = rules;
        const config = generate();
        if (rules === undefined) {
          assert.ok(!config.includes("AGENT_AUTOLOOP_RULES"));
          assert.ok(!config.includes("rules.json"), "default rules must remain implicit");
        } else {
          const absolute = path.resolve(rules);
          const expected =
            name === "launchd"
              ? `<key>AGENT_AUTOLOOP_RULES</key><string>${absolute.replaceAll("&", "&amp;")}</string>`
              : `Environment="AGENT_AUTOLOOP_RULES=${absolute.replaceAll("\\", "\\\\")}"`;
          assert.ok(config.includes(expected));
          assert.equal(config.match(/AGENT_AUTOLOOP_RULES/g)?.length, 1);
        }
      }
    } finally {
      if (previous === undefined) delete process.env.AGENT_AUTOLOOP_RULES;
      else process.env.AGENT_AUTOLOOP_RULES = previous;
    }
  });
}

test("service configuration escapes XML, quotes, backslashes, percent specifiers and control characters", () => {
  const previous = process.env.AGENT_AUTOLOOP_RULES;
  try {
    process.env.AGENT_AUTOLOOP_RULES = './规则 & <tag> "quote" %h $HOME/line\nnext\r\t.json';
    const xml = plist();
    assert.ok(xml.includes('规则 &amp; &lt;tag&gt; "quote" %h $HOME'));
    assert.ok(!xml.includes("<tag>"));
    const environment = unit()
      .split("\n")
      .filter((line) => line.startsWith("Environment="));
    assert.equal(environment.length, 2);
    const rules = environment.find((line) => line.includes("AGENT_AUTOLOOP_RULES"))!;
    assert.ok(rules.includes(String.raw`规则 & <tag> \"quote\" %%h $HOME`));
    assert.ok(rules.endsWith(String.raw`line\nnext\r\t.json"`));
    if (process.platform === "win32") assert.ok(rules.includes("\\\\"));
  } finally {
    if (previous === undefined) delete process.env.AGENT_AUTOLOOP_RULES;
    else process.env.AGENT_AUTOLOOP_RULES = previous;
  }
});
