// Failure mode: Windows path separators cause the watcher to ignore rules.json, leaving idle hubs on stale rules.
import assert from "node:assert/strict";
import { writeFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { setup } from "./helpers.ts";

const home = setup("rules-watch");
const file = join(home, "rules.json");
process.env.AGENT_AUTOLOOP_RULES = file;
const rules = { sources: {}, agents: {}, channels: {}, rules: [], askFirst: [] as string[] };
writeFileSync(file, JSON.stringify(rules));
const hub = await import("../host/runtime.ts");
const { makeHandler } = await import("../host/server.ts");

test("saving rules.json reloads an idle hub through the real file watcher", async () => {
  const runtime = makeHandler();
  try {
    const mtime = statSync(file).mtimeMs;
    rules.askFirst = ["Confirm before deployment"];
    writeFileSync(file, JSON.stringify(rules));
    // Ensure distinct mtimes even on filesystems with coarse timestamp resolution.
    utimesSync(file, new Date(), new Date(mtime + 2000));
    const deadline = Date.now() + 5000;
    while (hub.rules.askFirst.length === 0 && Date.now() < deadline) await setTimeout(20);
    assert.deepEqual(hub.rules.askFirst, rules.askFirst);
  } finally {
    runtime.close();
  }
});
