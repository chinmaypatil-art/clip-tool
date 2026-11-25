import assert from "node:assert/strict";
import { dropRepeats } from "../src/lib/whisper";

const c = (text: string) => ({ text, startMs: 0, endMs: 0, timestampMs: 0, confidence: null });
const run = (s: string) => dropRepeats(s.split(" ").map(c)).map((x) => x.text).join(" ");
assert.equal(run("aaj aaj, Aaj aaj aaj hai ok ok"), "aaj aaj, Aaj hai ok ok");
assert.equal(run("maaro do ki do ki do ki do ki do ki do bas"), "maaro do ki do ki do ki bas");
assert.equal(run("aja aja aja aja aja aja aja aja aja"), "aja aja aja");
assert.equal(run("main bhi main bhi aaya"), "main bhi main bhi aaya");
console.log("repeats ok");
