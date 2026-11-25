import assert from "node:assert/strict";
import { applyLayout, parseClipEdit, subtractRanges } from "../src/lib/clipEdit";

assert.deepEqual(subtractRanges([[0, 10]], [[2, 3], [8, 12]]), [[0, 2], [3, 8]]);
assert.deepEqual(subtractRanges([[0, 4], [5, 10]], [[3, 6]]), [[0, 3], [6, 10]]);
const f = applyLayout([{ fromSeconds: 0, toSeconds: 10, mode: "fill", focusX: 30 }], [{ fromSeconds: 4, toSeconds: 6, mode: "wide", focusX: 50 }], 10);
assert.deepEqual(f.map((s) => [s.mode, s.fromSeconds, s.toSeconds]), [["fill", 0, 4], ["wide", 4, 6], ["fill", 6, 10]]);
const e = parseClipEdit({ removed: [[1, 2], [5, 3], "x"], hook: "yes", wordFixes: [{ ms: 10, text: "Ra{m}\n" }], layout: [{ fromSeconds: 0, toSeconds: 1, mode: "evil" }] });
assert.deepEqual(e, { removed: [[1, 2]], wordFixes: [{ ms: 10, text: "Ra m  " }], layout: [] });
console.log("clip edit ok");
