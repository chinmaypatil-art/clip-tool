import path from "path";
import { mkdir, writeFile } from "fs/promises";
import { listAnalyses, type Analysis, type AnalysisClip, type ModelRun } from "./analyses";
import { clipLengthRange } from "./clipLength";
import { buildWindowClipPrompt } from "./providers/types";
import { buildTranscriptWindows, pickWindowSeconds } from "./transcriptWindows";
import type { TranscriptSegment } from "./transcript";

export const TRAINING_ROOT = path.join(process.cwd(), "storage", "training");

// Gemini's output may not be used to train other models (API terms). Its
// reviewed clips go to reviews.jsonl as a benchmark, never to sft.jsonl.
const NOT_FOR_TRAINING = new Set(["gemini"]);

const EDGE_SLACK_SECONDS = 5;

function textBetween(segments: TranscriptSegment[], start: number, end: number): string {
  return segments
    .filter((s) => s.endMs / 1000 > start && s.startMs / 1000 < end)
    .map((s) => s.text)
    .join(" ")
    .replace(/&gt;/g, ">");
}

function toReviewRecord(a: Analysis, run: ModelRun, clip: AnalysisClip) {
  const review = clip.review!;
  return {
    analysisId: a.id,
    source: a.sourceUrl ?? a.sourceLabel,
    runId: run.id,
    provider: run.provider,
    model: run.model,
    promptVersion: run.promptVersion,
    clipId: clip.id,
    title: clip.title,
    verdict: review.verdict,
    reasons: review.reasons,
    note: review.note,
    modelStart: clip.modelStartSeconds ?? clip.startSeconds,
    modelEnd: clip.modelEndSeconds ?? clip.endSeconds,
    start: clip.startSeconds,
    end: clip.endSeconds,
    text: a.transcript ? textBetween(a.transcript.segments, clip.startSeconds, clip.endSeconds) : "",
  };
}

/**
 * One fine-tuning example per transcript window a reviewer looked at (it
 * holds at least one reviewed clip). The answer is that window's approved
 * clips with the reviewer's corrected edges, so a window whose picks were all
 * rejected teaches the model to return nothing there. Windows with no
 * reviewed clips are skipped: nobody checked them, so an empty answer could
 * be wrong.
 */
function toSftExamples(a: Analysis): object[] {
  if (!a.transcript?.segments.length) return [];
  const segments = a.transcript.segments;
  const reviewed = a.runs
    .filter((run) => !NOT_FOR_TRAINING.has(run.provider))
    .flatMap((run) => run.clips.filter((c) => c.review).map((clip) => ({ run, clip })));
  if (!reviewed.length) return [];

  // Same windows and prompt Gemma picks with (createOllamaWindowedPicker), so
  // the fine-tuned model learns exactly the task it runs.
  const range = clipLengthRange(reviewed[0].run.clipLength);
  const examples: object[] = [];
  for (const w of buildTranscriptWindows(segments, pickWindowSeconds(range))) {
    // Edge fixes can move a clip a few seconds past the window it came from.
    const inside = reviewed.filter(
      ({ clip }) => clip.startSeconds >= w.startSeconds - EDGE_SLACK_SECONDS && clip.endSeconds <= w.endSeconds + EDGE_SLACK_SECONDS
    );
    if (!inside.length) continue;
    const good = inside
      .filter(({ clip }) => clip.review!.verdict === "good")
      .map(({ clip }) => clip)
      .sort((x, y) => x.startSeconds - y.startSeconds)
      // Two models can pick the same moment; keep it once.
      .filter((c, i, arr) => i === 0 || c.startSeconds >= arr[i - 1].endSeconds);
    examples.push({
      meta: { analysisId: a.id, from: w.startSeconds, to: w.endSeconds },
      messages: [
        { role: "user", content: buildWindowClipPrompt(w.segments, range) },
        {
          role: "assistant",
          content: JSON.stringify({
            clips: good.map((c) => ({
              start_time: Number(c.startSeconds.toFixed(1)),
              end_time: Number(c.endSeconds.toFixed(1)),
              title: c.title,
              hook: c.hook,
              description: c.description,
              viral_score: c.viralScore,
              category: c.category,
            })),
          }),
        },
      ],
    });
  }
  return examples;
}

export interface TrainingStats {
  reviews: number;
  good: number;
  examples: number;
}

/**
 * Rewrites storage/training/ from every saved analysis:
 * - reviews.jsonl: every reviewed clip from any model (benchmarks, stats)
 * - sft.jsonl: chat-format fine-tuning examples (local models' clips only)
 * Rebuilt from scratch each time, so changing a review never leaves a stale line.
 */
export async function exportTrainingData(): Promise<TrainingStats> {
  const reviews: object[] = [];
  const examples: object[] = [];
  for (const a of await listAnalyses()) {
    for (const run of a.runs) for (const clip of run.clips) if (clip.review) reviews.push(toReviewRecord(a, run, clip));
    examples.push(...toSftExamples(a));
  }
  await mkdir(TRAINING_ROOT, { recursive: true });
  const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r) + "\n").join("");
  await writeFile(path.join(TRAINING_ROOT, "reviews.jsonl"), jsonl(reviews));
  await writeFile(path.join(TRAINING_ROOT, "sft.jsonl"), jsonl(examples));
  return {
    reviews: reviews.length,
    good: reviews.filter((r) => (r as { verdict: string }).verdict === "good").length,
    examples: examples.length,
  };
}
