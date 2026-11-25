// Self-check for line-number picks: npx tsx scripts/check-line-picks.mts
import assert from "node:assert/strict";
import { parseNormalizedClips, spanToLines, parseClipCheck } from "../src/lib/providers/types";

const lines = [0, 5, 11, 20].map((s, i) => ({ text: `line ${i + 1}`, startMs: s * 1000, endMs: (s + 4) * 1000 }));

// Lines become those lines' exact times.
const [clip] = parseNormalizedClips(JSON.stringify({ clips: [{ from_line: 2, to_line: 3, title: "t", reason: "why" }] }), lines);
assert.equal(clip.startSeconds, 5);
assert.equal(clip.endSeconds, 15);
assert.equal(clip.reasoning, "why");

// Out-of-range and reversed numbers are clamped, never invented.
const [wild] = parseNormalizedClips(JSON.stringify({ clips: [{ from_line: 9, to_line: 0, title: "t" }] }), lines);
assert.equal(wild.startSeconds, 20);
assert.equal(wild.endSeconds, 24);

// Cloud models still answer in seconds.
const [timed] = parseNormalizedClips(JSON.stringify({ clips: [{ start_time: 1, end_time: 9, title: "t" }] }));
assert.equal(timed.startSeconds, 1);

// Training answers: times back to the lines they cover.
assert.deepEqual(spanToLines(lines, 4.7, 15.3), { from: 2, to: 3 });
assert.equal(spanToLines(lines, 100, 110), null);

// Check scores: 1-5 per question becomes 0-100; no usable scores is an error (clip keeps its rank).
assert.equal(parseClipCheck('{"standalone": 5, "hook": 5, "ending": 5, "real_content": 5}').score, 100);
assert.equal(parseClipCheck('{"standalone": 1, "hook": 3, "ending": 5, "real_content": 3}').score, 50);
assert.throws(() => parseClipCheck("{}"));

console.log("line picks ok");
