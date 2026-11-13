// Runs clip picking on a stored Compare analysis without saving anything:
//   npx tsx scripts/try-windowed-picks.mts <analysisId> [provider] [model] [short|medium|long]
import path from "node:path";
import { loadAnalysis, analysisDir } from "../src/lib/analyses";
import { pickClips } from "../src/lib/analysisPipeline";
import { clipLengthRange, type ClipLengthPreset } from "../src/lib/clipLength";

const [id, provider = "ollama-local", model = "gemma3:12b", length = "short"] = process.argv.slice(2);
const analysis = await loadAnalysis(id);
if (!analysis?.transcript) throw new Error(`No transcript for analysis ${id}`);
const range = clipLengthRange(length as ClipLengthPreset);
const started = Date.now();
const result = await pickClips({
  provider,
  model,
  segments: analysis.transcript.segments,
  durationSeconds: analysis.videoDurationSeconds ?? Infinity,
  range,
  sourcePath: path.join(analysisDir(id), "source.mp4"),
});
const mmss = (s: number) => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;
console.log(`range ${range.minSeconds}-${range.maxSeconds}s | model ${(result.durationMs / 1000).toFixed(1)}s | total ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(JSON.stringify(result.rawResponse, null, 1).slice(0, 1500));
for (const c of result.clips) {
  console.log(`${mmss(c.startSeconds)}-${mmss(c.endSeconds)}  ${(c.endSeconds - c.startSeconds).toFixed(0)}s  [${c.viralScore}] ${c.title}`);
}
