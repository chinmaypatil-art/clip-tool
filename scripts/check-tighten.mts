// Self-check for filler/pause trimming: npx tsx scripts/check-tighten.mts
import assert from "node:assert/strict";
import { keepRanges, keptLength, mapTime, remapCaptions, remapFraming } from "../src/lib/tighten";

const w = (text: string, s: number, e: number) => ({ text, startMs: s * 1000, endMs: e * 1000, timestampMs: null, confidence: null });

// A 3 s pause becomes 0.2 s; a long "um" surrounded by pauses goes too.
const words = [w("Hello", 0.2, 1), w("there.", 1, 2), w(" um,", 3.5, 4), w("So", 6, 6.5), w("yes.", 6.5, 7)];
const keep = keepRanges(words, 8);
assert.deepEqual(keep, [[0, 2.1], [5.9, 8]]);
assert.equal(+keptLength(keep).toFixed(2), 4.2);
assert.equal(+mapTime(keep, 6).toFixed(2), 2.2);
assert.equal(+mapTime(keep, 4).toFixed(2), 2.1); // inside a cut: start of next piece
const caps = remapCaptions(words, keep);
assert.deepEqual(caps.map((c) => c.text), ["Hello", "there.", "So", "yes."]);
assert.equal(caps[2].startMs, 2200);

// A quick "uh" mid-sentence stays (no jumpy cut), and small savings don't re-cut.
assert.deepEqual(keepRanges([w("I", 0, 0.3), w("uh", 0.35, 0.5), w("think", 0.55, 1)], 1.5), [[0, 1.5]]);
assert.deepEqual(keepRanges([], 10), [[0, 10]]);

const shots = remapFraming([{ fromSeconds: 0, toSeconds: 3, mode: "fill", focusX: 50 }, { fromSeconds: 3, toSeconds: 8, mode: "split", focusX: 50 }], keep);
assert.equal(+shots[1].fromSeconds.toFixed(2), 2.1);
console.log("tighten ok");
