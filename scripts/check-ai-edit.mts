import assert from "node:assert/strict";
import { clauses, mergeOps, ruleEdit } from "../src/lib/aiEdit";

const run = (req: string) => {
  const parts = clauses(req).map((c) => ruleEdit(c, 28));
  return parts.includes(null) ? null : mergeOps(parts as NonNullable<(typeof parts)[number]>[]);
};
assert.equal(run("remove the ums and turn off the hook")?.hook, false);
assert.equal(run("remove the ums and turn off the hook")?.fillers, true);
assert.deepEqual(run("show both people during sentence 3")?.layout, [{ from: 3, to: 3, mode: "fit" }]);
assert.deepEqual(run("zoom out in sentences 4 to 6")?.layout, [{ from: 4, to: 6, mode: "wide" }]);
assert.equal(run("hide the captions")?.captions, false);
assert.equal(run("end the clip at sentence 20")?.end, 20);
assert.deepEqual(run("cut sentences 2 to 4")?.remove, [2, 3, 4]);
assert.deepEqual(run("delete sentence 1")?.remove, [1]);
assert.deepEqual(run("remove silences")?.pauses, true);
assert.equal(run("make it about 30 seconds"), null);
assert.equal(run("cut the bit about his dad"), null);
console.log("ai edit ok");
