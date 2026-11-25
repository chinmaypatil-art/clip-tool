// Self-check for speaker switching in two-person shots: npx tsx scripts/check-speaker-framing.mts
import assert from "node:assert/strict";
import { speakerRuns } from "../src/lib/framing";

// Samples are 1/4 s. talk(a, b, n): n samples where person 0 moves a and person 1 moves b.
const talk = (a: number, b: number, n: number) => Array.from({ length: n }, () => [a, b] as [number, number]);
const who = (m: Array<[number | null, number | null]>) => speakerRuns(m).map((r) => r.who);

// Clear turns, 4 s each: one switch.
assert.deepEqual(who([...talk(10, 1, 16), ...talk(1, 10, 16)]), [0, 1]);
// Flicking every 1 s is noise: no switching at all.
assert.equal(new Set(who(Array.from({ length: 8 }, (_, i) => talk(i % 2 ? 1 : 10, i % 2 ? 10 : 1, 4)).flat())).size, 1);
// Both talking equally: stay on both.
assert.deepEqual(who(talk(5, 5, 20)), ["both"]);
// A 1 s interjection inside a long turn is ignored.
assert.deepEqual(who([...talk(10, 1, 16), ...talk(1, 10, 4), ...talk(10, 1, 16)]), [0]);
// A face the detector missed for a moment doesn't break a turn.
assert.deepEqual(who([...talk(10, 1, 12), [null, 1], ...talk(10, 1, 12)]), [0]);
// Every run is at least 2.5 s (10 samples) when there is more than one.
for (const r of speakerRuns([...talk(10, 1, 12), ...talk(1, 10, 12), ...talk(10, 1, 12)])) assert.ok(r.to - r.from >= 10);
console.log("speaker framing ok");
