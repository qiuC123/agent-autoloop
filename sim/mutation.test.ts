// Failure modes: the safety tests pass after an authorization, deduplication, queue, receipt, deadline, replay or transaction
// guard is removed; mutation reporting counts syntax errors as detections or silently omits surviving mutations.
// Dropping the receipt FYI flag must be caught, not hidden in the allowed survival percentage.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mutate } from "./mutate.ts";
test("at least 95 percent of executable kernel mutations are detected", () => {
  const result = mutate();
  console.log(JSON.stringify(result));
  assert.equal(result.invalid.length, 0);
  assert.ok(!result.survived.includes("receipt-fyi"));
  assert.ok(result.killed / result.total >= 0.95, JSON.stringify(result.survived));
});
