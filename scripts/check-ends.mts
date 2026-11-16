// Usage: npx tsx scripts/check-ends.mts <analysisId>  — prints each clip's end before/after snapToSentences.
import { readFileSync } from "node:fs";
import { snapToSentences, toSentences } from "../src/lib/clipTrim";
const a = JSON.parse(readFileSync(`storage/analyses/${process.argv[2]}/analysis.json`, "utf8"));
const segs = a.transcript.segments;
const sents = toSentences(segs);
const run = a.runs.filter((r: { provider: string }) => r.provider === "ollama-local").pop();
for (const c of run.clips) {
  const s = snapToSentences(c.startSeconds, c.endSeconds, 260, segs);
  const last = sents.filter((x) => x.start < s.endSeconds - 0.3).pop();
  console.log(`${c.title.slice(0, 40).padEnd(40)} end ${c.endSeconds.toFixed(1)} -> ${s.endSeconds.toFixed(1)} | ends: "${last?.text.slice(-70)}"`);
}
