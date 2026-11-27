import path from "path";
import { copyFile, link, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { createTikTokStyleCaptions, type Caption } from "@remotion/captions";
import { hookToSentence, keepRanges, keptLength, remapCaptions, remapFraming, type KeepRange } from "./tighten";
import { applyLayout, subtractRanges } from "./clipEdit";
import { randomUUID } from "crypto";
import { createLimiter } from "./limit";
import { autoPickWithClaude } from "./claudePicker";
import { StageTimer } from "./timing";
import { processSingleton } from "./processState";
import { ensureOllama } from "./ollamaHealth";
import { parseCaptionStyle, WORDS_COMBINE_MS } from "./captionStyle";
import { fetchVideoTitle, downloadVideo, probeVideo, extractAudioSegment, captureThumbnail, cutClip, findSilences, isYoutubeUrl, isUrl, MediaError } from "./media";
import { extractYoutubeTranscript, captionsToSegments, referenceText, TranscriptError } from "./transcript";
import { detectWavLanguage, transcribeWav, WhisperError } from "./whisper";
import { bundleForJob, renderClip, RenderError } from "./render";
import { analyzeFraming } from "./framing";
import { runAnalysis, listAllProviders, getLocalRomanizer, getLocalEndChecker, getLocalWindowedPicker, getLocalClipChecker, getLocalHookPicker } from "./providers/registry";
import { ANALYSIS_PROMPT_VERSION, ProviderError, type ClipChecker, type EndChecker, type HookPicker, type NormalizedClip } from "./providers/types";
import {
  ensureAnalysisDir,
  analysisDir,
  updateAnalysis,
  addRun,
  updateRun,
  updateRunClip,
  getAnalysis,
  listAnalyses,
  type ModelRun,
  type AnalysisClip,
} from "./analyses";
import type { Provider } from "./keystore";
import { CLIP_LENGTH_PRESETS, clipLengthRange, DEFAULT_CLIP_COUNT, DEFAULT_CLIP_LENGTH, type ClipLengthPreset, type ClipLengthRange } from "./clipLength";
import type { TranscriptSegment } from "./transcript";
import { trimTrailingQuestion, fitToMaxLength, snapToSentences, endContext, snapToSilence, reachMinLength, includeLeadQuestion } from "./clipTrim";

export class AnalysisPipelineError extends Error {}

// Picks this far under the chosen minimum are still kept.
const SHORT_TOLERANCE = 0.6;
// A local model reading one window marks the moment itself and ignores long
// length ranges (30-155s picks for a 3-4 min setting, all dropped). Any pick
// this long counts as the core moment; setup before it makes up the length.
const LOCAL_MIN_MOMENT_SECONDS = 20;
// A clip shorter than the chosen length only gets this much lead-in before
// its moment. Padding it all the way to the minimum pulled in the end of the
// previous topic; a clean shorter clip is worth more than a long broken one.
const MAX_SETUP_SECONDS = 20;
// No clip under a minute, whatever the topic (the team's floor).
const HARD_MIN_SECONDS = 60;
const shortestClip = (range: ClipLengthRange) => Math.min(range.minSeconds, HARD_MIN_SECONDS);

/**
 * Downloads the source (needed later for rendering regardless of path) and
 * extracts a transcript: YouTube captions for YouTube URLs, or a full-video
 * Whisper transcription for everything else. Every model run against this
 * analysis uses this exact same transcript — required for a fair comparison.
 */

/**
 * Whole-video Whisper and Gemma's picking each fill most of the GPU; when two
 * people submit at once, the second waits instead of both running out of
 * memory. (Per-clip work during rendering is short and isn't gated.)
 */
const gpuSlot = processSingleton("gpuSlot", () => createLimiter(1));

/** Same video despite share-link noise: YouTube by its 11-character id (watch, live, shorts, youtu.be), else the exact URL. */
export function sameVideo(a: string | undefined, b: string): boolean {
  const id = (u: string) => u.match(/(?:v=|youtu\.be\/|\/live\/|\/shorts\/|\/embed\/)([\w-]{11})/)?.[1] ?? u;
  return !!a && id(a) === id(b);
}

export async function runTranscriptExtraction(
  analysisId: string,
  source: { kind: "url"; url: string } | { kind: "file"; path: string }
): Promise<void> {
  try {
    const dir = await ensureAnalysisDir(analysisId);
    const sourcePath = path.join(dir, "source.mp4");

    if (source.kind === "url") {
      if (!isUrl(source.url)) throw new AnalysisPipelineError("Not a valid http(s) URL.");
      updateAnalysis(analysisId, { status: "extracting_transcript" });
      // A link already downloaded (e.g. a retry of a 7 GB stream) is reused, not fetched again.
      const earlier = (await listAnalyses()).find(
        (a) => a.id !== analysisId && sameVideo(a.sourceUrl, source.url) && a.downloadedAt && !a.sourceDeleted && existsSync(path.join(analysisDir(a.id), "source.mp4"))
      );
      if (earlier) {
        const from = path.join(analysisDir(earlier.id), "source.mp4");
        // A hard link shares the bytes without using more disk; copy if linking isn't possible.
        await link(from, sourcePath).catch(() => copyFile(from, sourcePath));
      } else {
        await downloadVideo(source.url, sourcePath, () => {});
      }
    } else {
      await copyFile(source.path, sourcePath);
    }
    updateAnalysis(analysisId, { downloadedAt: Date.now() });

    const probe = await probeVideo(sourcePath);
    if (probe.durationSeconds < 30) {
      throw new AnalysisPipelineError("Video is too short to extract meaningful clips (minimum 30 seconds).");
    }
    updateAnalysis(analysisId, { videoDurationSeconds: probe.durationSeconds });

    if (source.kind === "url" && isYoutubeUrl(source.url)) {
      const transcriptDir = path.join(dir, "transcript-tmp");
      try {
        const transcript = await extractYoutubeTranscript(source.url, transcriptDir);
        updateAnalysis(analysisId, {
          status: "ready",
          transcriptReadyAt: Date.now(),
          transcript: { segments: transcript.segments, language: transcript.language, source: transcript.source },
        });
        return;
      } catch (err) {
        // No usable YouTube captions (none exist, or YouTube is rate-limiting
        // us) — not fatal: we already have the video, so transcribe it locally.
        if (!(err instanceof TranscriptError)) throw err;
        console.error(`[analysisPipeline] YouTube captions unavailable, falling back to Whisper:`, err.message);
      }
    }

    // Non-YouTube source, or a YouTube video whose captions we couldn't get —
    // transcribe the full video locally with Whisper.
    const wavPath = path.join(dir, "full-audio.wav");
    await extractAudioSegment(sourcePath, wavPath, 0, probe.durationSeconds);
    // Only models read this transcript, and they read Devanagari fine — no romanization needed.
    // No gap re-checks either: each gap costs ~35 s (a 66-min video spent 30+ min
    // on them), and every picked clip is re-transcribed with them anyway.
    const captions = await gpuSlot(
      () => transcribeWav(wavPath, { romanizer: null, fillGaps: false, onLanguage: (spokenLanguage) => updateAnalysis(analysisId, { spokenLanguage }) }),
      (ahead) => updateAnalysis(analysisId, { queueAhead: ahead || undefined })
    );
    const segments = captionsToSegments(captions);
    updateAnalysis(analysisId, {
      status: "ready",
      transcriptReadyAt: Date.now(),
      transcript: { segments, language: "en", source: "whisper" },
    });
  } catch (err) {
    const message =
      err instanceof AnalysisPipelineError || err instanceof MediaError || err instanceof TranscriptError || err instanceof WhisperError
        ? err.message
        : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[analysisPipeline] transcript extraction failed for ${analysisId}:`, err);
    updateAnalysis(analysisId, { status: "error", error: message });
  }
}

/** The model the one-click flow picks clips with. */
export const CLIP_PICKER = {
  provider: (process.env.CLIP_PROVIDER ?? "ollama-local") as Provider,
  model: process.env.CLIP_MODEL ?? "gemma3:12b",
};

/**
 * The one-click flow: video in, picked clips out. Transcript, then the local
 * model picks clips; the user renders the ones they want.
 */
export async function makeClips(
  analysisId: string,
  source: { kind: "url"; url: string } | { kind: "file"; path: string }
): Promise<void> {
  if (source.kind === "url") {
    void fetchVideoTitle(source.url).then((title) => title && updateAnalysis(analysisId, { title }));
  }
  await runTranscriptExtraction(analysisId, source);
  const analysis = getAnalysis(analysisId);
  if (analysis?.status !== "ready") return;
  // Gemma picks from the words; with hardly any speech (raw sports, phone
  // footage) it has nothing to go on, so Claude picks by watching instead.
  if (analysis.picker === "claude" || !hasUsableSpeech(analysis.transcript?.segments ?? [], analysis.videoDurationSeconds)) {
    updateAnalysis(analysisId, { waitingForClaude: true });
    autoPickWithClaude(analysisId);
    return;
  }

  // Nothing renders by itself: the user sees the picks and hooks first and
  // renders only the ones they want.
  await runModelAgainstAnalysis(analysisId, CLIP_PICKER.provider, CLIP_PICKER.model, analysis.clipLength);
}

/** Enough words for a transcript picker: at least 30 a minute (talk runs 120+). */
export function hasUsableSpeech(segments: TranscriptSegment[], durationSeconds: number | null): boolean {
  const words = segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  const minutes = Math.max(1, (durationSeconds ?? 0) / 60);
  return words >= 40 && words / minutes >= 30;
}

/**
 * Clips an outside picker chose by watching the video (Claude over MCP, for
 * footage with no useful transcript). Saved as a finished run; like the
 * one-click flow, the user chooses which ones to render.
 */
export function addPickedClips(analysisId: string, picker: string, picked: NormalizedClip[]): string {
  const analysis = getAnalysis(analysisId);
  const clipLength = analysis?.clipLength ?? DEFAULT_CLIP_LENGTH;
  const { minSeconds } = CLIP_LENGTH_PRESETS[clipLength];
  const videoEnd = analysis?.videoDurationSeconds ?? Infinity;
  // A pick under the chosen length is widened around its middle (the picker
  // kept the action there) so a "1-2 min" video never gets 45 s clips.
  const fitted = picked.map((c) => {
    const short = minSeconds - (c.endSeconds - c.startSeconds);
    if (short <= 0) return c;
    let start = Math.max(0, c.startSeconds - short * 0.3);
    const end = Math.min(videoEnd, start + minSeconds);
    start = Math.max(0, end - minSeconds);
    return { ...c, startSeconds: start, endSeconds: end };
  });
  const run: ModelRun = {
    id: randomUUID(),
    provider: "mcp",
    model: picker,
    status: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    durationMs: 0,
    tokenUsage: null,
    keyLabel: null,
    attempts: null,
    error: null,
    promptVersion: "mcp-vision-1",
    clips: fitted.map((c): AnalysisClip => ({ ...c, id: randomUUID(), renderStatus: "pending" })),
    rawResponse: picked,
    clipLength,
  };
  addRun(analysisId, run);
  updateAnalysis(analysisId, { waitingForClaude: undefined });
  return run.id;
}

/** Runs one provider/model against an analysis's already-extracted transcript. */
export async function runModelAgainstAnalysis(
  analysisId: string,
  provider: Provider,
  model: string,
  clipLength?: ClipLengthPreset
): Promise<void> {
  const analysis = getAnalysis(analysisId);
  if (!analysis || !analysis.transcript) {
    throw new AnalysisPipelineError("Analysis has no extracted transcript yet.");
  }
  // A double-clicked Run button used to start every model again, burning
  // free-tier quota on identical requests.
  if (analysis.runs.some((r) => r.provider === provider && r.model === model && r.status === "running")) return;

  const run: ModelRun = {
    id: randomUUID(),
    provider,
    model,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    durationMs: null,
    tokenUsage: null,
    keyLabel: null,
    attempts: null,
    error: null,
    promptVersion: ANALYSIS_PROMPT_VERSION,
    clipLength,
    clips: [],
    rawResponse: null,
  };
  addRun(analysisId, run);

  try {
    const transcript = analysis.transcript;
    await ensureOllama();
    const result = await gpuSlot(() =>
      pickClips({
        provider,
        model,
        segments: transcript.segments,
        durationSeconds: analysis.videoDurationSeconds ?? Infinity,
        range: clipLengthRange(clipLength),
        sourcePath: path.join(analysisDir(analysisId), "source.mp4"),
        focus: analysis.focus,
        count: analysis.clipCount,
      }),
      (ahead) => updateRun(analysisId, run.id, { queueAhead: ahead || undefined })
    );
    const clips = result.clips.map((c): AnalysisClip => ({ ...c, id: randomUUID(), renderStatus: "pending" }));

    updateRun(analysisId, run.id, {
      status: "done",
      finishedAt: Date.now(),
      durationMs: result.durationMs,
      tokenUsage: result.tokenUsage,
      keyLabel: result.meta.keyLabel,
      attempts: result.meta.attempts,
      clips,
      rawResponse: result.rawResponse,
    });
  } catch (err) {
    const message = err instanceof ProviderError ? err.message : err instanceof Error ? err.message : String(err);
    console.error(`[analysisPipeline] model run failed (${provider}/${model}) for ${analysisId}: ${message}`);
    updateRun(analysisId, run.id, { status: "error", finishedAt: Date.now(), error: message });
  }
}

/**
 * Has a model pick clips from a transcript, then cleans them up: length
 * limits, overlaps, whole sentences, a finished thought at the end (local
 * models) and cuts in real pauses. Shared by Compare and New Clip.
 */
export async function pickClips({
  provider,
  model,
  segments,
  durationSeconds,
  range,
  sourcePath,
  focus,
  count = DEFAULT_CLIP_COUNT,
}: {
  provider: Provider;
  model: string;
  segments: TranscriptSegment[];
  durationSeconds: number;
  range: ClipLengthRange;
  sourcePath: string;
  /** What the user asked for ("funny moments"); local models only. */
  focus?: string;
  /** How many clips to keep (the user picks 3-10). */
  count?: number;
}) {
  // Local models read the transcript a few minutes at a time; cloud models
  // (the benchmark) still get it whole in one call.
  const windowed = await getLocalWindowedPicker(provider, model);
  const result = windowed
    ? {
        ...(await windowed({ segments, targetCount: count + SPARE_PICKS, range, focus })),
        meta: { keyId: "local", keyLabel: "local (no key)", attempts: 1 },
      }
    : await runAnalysis(provider, model, segments, count, range);
  const minPick = windowed ? Math.min(LOCAL_MIN_MOMENT_SECONDS, range.minSeconds * SHORT_TOLERANCE) : range.minSeconds * SHORT_TOLERANCE;
  const picked = keepBest(clampAndDedupe(result.clips, durationSeconds, range, segments, minPick), count + SPARE_PICKS);
  const refined = await refineEdges(picked, range, segments, sourcePath, await getLocalEndChecker(provider, model));
  const checked = await rankByCheck(refined, segments, await getLocalClipChecker(provider, model));
  const final = keepBest(checked, count).map((c) => ({ ...c, startSeconds: includeLeadQuestion(c.startSeconds, c.endSeconds, segments, range.maxSeconds) }));
  return { ...result, clips: await addHooks(final, segments, await getLocalHookPicker(provider, model)) };
}

// A cold open shorter than this is a fragment; longer delays the clip itself.
const HOOK_MIN_SECONDS = 2;
const HOOK_MAX_SECONDS = 8;
// In a short clip the teaser is a big share of it and plays as an obvious
// repeat (reviewers: "the end is again what was in the beginning").
export const HOOK_MIN_CLIP_SECONDS = 60;

/**
 * Hook-first: the local model names the clip's strongest line, which then
 * plays once before the clip starts (see renderAnalysisClip). A clip whose
 * opening is already its best line, or whose pick is too short/long, keeps
 * its own opening.
 */
async function addHooks<T extends { startSeconds: number; endSeconds: number; title: string }>(
  clips: T[],
  segments: TranscriptSegment[],
  pick: HookPicker | undefined
): Promise<Array<T & { hookStartSeconds?: number; hookEndSeconds?: number }>> {
  if (!pick) return clips;
  const out: Array<T & { hookStartSeconds?: number; hookEndSeconds?: number }> = [];
  for (const clip of clips) {
    if (clip.endSeconds - clip.startSeconds < HOOK_MIN_CLIP_SECONDS) {
      out.push(clip);
      continue;
    }
    const lines = segments.filter((s) => s.endMs / 1000 > clip.startSeconds + 0.5 && s.startMs / 1000 < clip.endSeconds - 0.5);
    try {
      const n = lines.length > 2 ? await pick(lines) : 0;
      const line = lines[n - 1];
      const from = line && Math.max(clip.startSeconds, line.startMs / 1000);
      const to = line && Math.min(clip.endSeconds, line.endMs / 1000);
      if (line && to - from >= HOOK_MIN_SECONDS && to - from <= HOOK_MAX_SECONDS && from > clip.startSeconds + 1) {
        console.log(`[analysisPipeline] hook for "${clip.title}": ${line.text}`);
        out.push({ ...clip, hookStartSeconds: from, hookEndSeconds: to });
        continue;
      }
    } catch (err) {
      console.error("[analysisPipeline] hook pick failed, keeping the clip's opening:", err);
    }
    out.push(clip);
  }
  return out;
}

// Extra windows the local model picks from, so the final check has spares
// to rank the weakest clips out with.
const SPARE_PICKS = 2;

/**
 * Has the local model read each finished clip on its own, as a viewer would,
 * and folds that score into the clip's rank, so keepBest leaves out the
 * weakest. Ranks, never deletes: an untuned gemma3:12b judged nearly every
 * clip as broken. A check that errors leaves its clip's score as it was.
 */
async function rankByCheck<T extends { startSeconds: number; endSeconds: number; viralScore: number; title: string }>(
  clips: T[],
  segments: TranscriptSegment[],
  check: ClipChecker | undefined
): Promise<T[]> {
  if (!check) return clips;
  const out: T[] = [];
  for (const clip of clips) {
    const text = referenceText(segments, clip.startSeconds, clip.endSeconds);
    try {
      if (!text) throw new Error("no transcript text");
      const { score, problem } = await check(text);
      console.log(`[analysisPipeline] check ${score}/100 "${clip.title}"${problem ? `: ${problem}` : ""}`);
      out.push({ ...clip, viralScore: Math.round((clip.viralScore + score) / 2) });
    } catch (err) {
      console.error("[analysisPipeline] clip check failed, keeping its score:", err);
      out.push(clip);
    }
  }
  return out;
}

function clampAndDedupe<T extends { startSeconds: number; endSeconds: number; viralScore: number }>(
  clips: T[],
  durationSeconds: number,
  range: ClipLengthRange,
  segments?: TranscriptSegment[],
  minPickSeconds = range.minSeconds * SHORT_TOLERANCE
): T[] {
  const cleaned: T[] = [];
  for (const clip of clips) {
    if (!Number.isFinite(clip.startSeconds) || !Number.isFinite(clip.endSeconds)) continue;
    const start = Math.max(0, Math.min(clip.startSeconds, durationSeconds));
    const end = trimTrailingQuestion(start, Math.max(0, Math.min(clip.endSeconds, durationSeconds)), segments);
    const length = end - start;
    if (length < minPickSeconds) continue;
    const clampedEnd = fitToMaxLength(start, end, range.maxSeconds, minPickSeconds, segments);
    const setup = reachMinLength(start, clampedEnd, range.minSeconds, durationSeconds, MAX_SETUP_SECONDS);
    // Still short after the lead-in: the user chose this length, so carry
    // on past the end (snapToSentences then ends it on a full sentence).
    const long =
      setup.endSeconds - setup.startSeconds < range.minSeconds
        ? { ...setup, endSeconds: Math.min(durationSeconds, setup.startSeconds + range.minSeconds + 5) }
        : setup;
    const snapped = snapToSentences(long.startSeconds, long.endSeconds, range.maxSeconds, segments);
    if (snapped.endSeconds - snapped.startSeconds < shortestClip(range)) continue;
    cleaned.push({ ...clip, ...snapped });
  }
  cleaned.sort((a, b) => b.viralScore - a.viralScore);
  const kept: T[] = [];
  for (const c of cleaned) {
    const overlaps = kept.some((k) => c.startSeconds < k.endSeconds && c.endSeconds > k.startSeconds);
    if (!overlaps) kept.push(c);
  }
  kept.sort((a, b) => a.startSeconds - b.startSeconds);
  return kept;
}

/**
 * The `count` highest-scoring clips, back in video order. By score, never by
 * position: dropping the tail of a time-sorted list throws away the back half
 * of the video.
 */
function keepBest<T extends { startSeconds: number; viralScore: number }>(clips: T[], count: number): T[] {
  if (clips.length <= count) return clips;
  return [...clips]
    .sort((a, b) => b.viralScore - a.viralScore)
    .slice(0, count)
    .sort((a, b) => a.startSeconds - b.startSeconds);
}

/**
 * Final pass on each clip's edges:
 * 1. a local model checks the clip ends where the point lands: it may keep a
 *    few more sentences, or end earlier when the clip drifts into another
 *    topic (an early end is made up with setup before it, not padding after);
 * 2. both edges move into real pauses in the audio, since caption timings run
 *    a second or two early and cut off the last words.
 * A clip that would grow into its neighbour keeps its old end.
 */
async function refineEdges<T extends { startSeconds: number; endSeconds: number }>(
  clips: T[],
  range: ClipLengthRange,
  segments: TranscriptSegment[],
  sourcePath: string,
  checkEnd: EndChecker | undefined
): Promise<T[]> {
  const out: T[] = [];
  for (const [i, clip] of clips.entries()) {
    let { startSeconds, endSeconds } = clip;
    const nextStart = clips[i + 1]?.startSeconds ?? Infinity;
    if (checkEnd) {
      try {
        const { inside, following } = endContext(startSeconds, endSeconds, segments);
        const endAfter = inside.length ? await checkEnd({ inside, following }) : 0;
        const newEnd =
          endAfter > 0 ? following[endAfter - 1].end : endAfter < 0 ? inside[inside.length - 1 + endAfter].end : endSeconds;
        // An earlier end may not take the clip under the chosen length.
        const longEnough = newEnd >= endSeconds || newEnd - startSeconds >= range.minSeconds - 3;
        if (longEnough && newEnd > startSeconds + 3 && newEnd - startSeconds <= range.maxSeconds && newEnd < nextStart) {
          endSeconds = newEnd;
          if (endSeconds - startSeconds < range.minSeconds) {
            // Ended early: take a little setup before it, never more after.
            const grown = reachMinLength(startSeconds, endSeconds, range.minSeconds, endSeconds, MAX_SETUP_SECONDS);
            const prevEnd = out[out.length - 1]?.endSeconds ?? 0;
            const snappedStart = snapToSentences(grown.startSeconds, endSeconds, range.maxSeconds, segments).startSeconds;
            startSeconds = Math.max(prevEnd, Math.min(grown.startSeconds, snappedStart));
          }
        }
      } catch (err) {
        console.error("[analysisPipeline] end check failed, keeping the clip's end:", err);
      }
    }
    try {
      // Only the audio around each edge matters, not the whole clip.
      const [head, tail] = await Promise.all([
        findSilences(sourcePath, startSeconds - 1, startSeconds + 3),
        findSilences(sourcePath, endSeconds - 2, endSeconds + 4),
      ]);
      const silences = [...head, ...tail];
      const snapped = snapToSilence(startSeconds, endSeconds, { ...range, minSeconds: Math.max(1, range.minSeconds - 3) }, silences);
      if (snapped.endSeconds < nextStart) ({ startSeconds, endSeconds } = snapped);
    } catch (err) {
      console.error("[analysisPipeline] silence snap failed, keeping transcript edges:", err);
    }
    out.push({ ...clip, startSeconds, endSeconds });
  }
  return out;
}

const serveUrlCache = new Map<string, string>();

/** The short cut of the source a clip renders from (served by the files route). */
export function segmentFilename(runId: string, clipId: string): string {
  return `segment-${runId}-${clipId}.mp4`;
}

const APP_ORIGIN = `http://127.0.0.1:${process.env.PORT ?? 3000}`;

/**
 * Deletes the Remotion bundle made for an analysis. Bundling copies the whole
 * analysis folder (source video included) into a temp directory, so this
 * matters when freeing disk space.
 */
export async function forgetRenderBundle(analysisId: string): Promise<void> {
  const serveUrl = serveUrlCache.get(analysisId);
  serveUrlCache.delete(analysisId);
  if (serveUrl && path.isAbsolute(serveUrl)) await rm(serveUrl, { recursive: true, force: true }).catch(() => {});
}

/** Renders one clip from one model run, reusing the existing Remotion pipeline unchanged. */
export async function renderAnalysisClip(analysisId: string, runId: string, clipId: string): Promise<void> {
  const analysis = getAnalysis(analysisId);
  const run = analysis?.runs.find((r) => r.id === runId);
  const clip = run?.clips.find((c) => c.id === clipId);
  if (!analysis || !run || !clip) throw new AnalysisPipelineError("Clip not found.");

  updateRunClip(analysisId, runId, clipId, {
    renderStatus: "rendering",
    renderQueuedAt: Date.now(),
    renderStartedAt: undefined,
    renderFinishedAt: undefined,
  });
  // A reviewer may change the edges while this renders; render what was asked.
  const { startSeconds, endSeconds } = clip;

  try {
    const dir = analysisDir(analysisId);
    const sourcePath = path.join(dir, "source.mp4");
    const clipLength = endSeconds - startSeconds;
    const filename = `render-${runId}-${clip.id}.mp4`;
    const thumbFilename = `render-${runId}-${clip.id}-thumb.jpg`;
    const outPath = path.join(dir, filename);
    const wavPath = path.join(dir, `render-${runId}-${clip.id}-audio.wav`);

    const timer = new StageTimer(`${analysisId.slice(0, 8)}/${clipId.slice(0, 8)}`);
    // Face-aware crop, computed alongside captions; letterbox if it fails.
    const framingPromise = timer.time("framing", () => analyzeFraming(sourcePath, startSeconds, clipLength)).catch((err) => {
      console.error(`[analysisPipeline] framing analysis failed for ${analysisId}/${runId}/${clipId}:`, err);
      return [];
    });

    // Older analyses have no setting and keep the default captions.
    const userEdit = clip.edit ?? {};
    const captionStyle =
      userEdit.captionStyle !== undefined ? userEdit.captionStyle : analysis.captionStyle === null ? null : parseCaptionStyle(analysis.captionStyle);
    let captions: Caption[] = [];
    try {
      if (captionStyle) {
        await extractAudioSegment(sourcePath, wavPath, startSeconds, clipLength);
        const romanizer = await getLocalRomanizer(run.provider, run.model);
        // Videos transcribed before the language was stored: detect it once from the full audio.
        const fullAudio = path.join(dir, "full-audio.wav");
        if (!analysis.spokenLanguage && existsSync(fullAudio)) {
          const spokenLanguage = await detectWavLanguage(fullAudio).catch(() => undefined);
          if (spokenLanguage) updateAnalysis(analysisId, { spokenLanguage });
          analysis.spokenLanguage = spokenLanguage;
        }
        captions = await timer.time("captions", () =>
          transcribeWav(wavPath, {
            romanizer,
            reference: referenceText(analysis.transcript?.segments, startSeconds, startSeconds + clipLength),
            language: analysis.spokenLanguage,
          })
        );
      }
    } catch (err) {
      console.error(`[analysisPipeline] caption generation failed for ${analysisId}/${runId}/${clipId}:`, err);
    }

    // Bundling copies the whole folder, source included: only do it when the
    // ffmpeg renderer fails and Remotion is needed.
    const serveUrl = async () => {
      let url = serveUrlCache.get(analysisId);
      if (!url) {
        url = await bundleForJob(dir);
        serveUrlCache.set(analysisId, url);
      }
      return url;
    };

    // Render from a short ffmpeg cut, not the full source: seeking deep into a
    // long video made Remotion fail with "No frame found at position" (twice
    // in a row, so the retry didn't help). The bundle is a snapshot of the
    // folder, so the cut is fetched over HTTP from the app instead.
    const segment = segmentFilename(runId, clip.id);
    const segmentPath = path.join(dir, segment);
    // Fillers and long pauses come out using the caption words' timings, so a
    // clip rendered without captions keeps its pauses.
    for (const fix of userEdit.wordFixes ?? []) {
      const word = captions.find((w) => Math.abs(startSeconds * 1000 + w.startMs - fix.ms) < 50);
      if (word) word.text = (word.text.startsWith(" ") ? " " : "") + fix.text.trim();
    }
    const toClip = (r: KeepRange): KeepRange => [r[0] - startSeconds, r[1] - startSeconds];
    const tight = subtractRanges(
      userEdit.trimPauses === false ? [[0, clipLength]] : keepRanges(captions, clipLength),
      (userEdit.removed ?? []).map(toClip)
    );
    // Hook-first: the chosen line plays once, then the clip from its start.
    // Skipped if a reviewer has since moved the edges past it.
    const hook =
      userEdit.hook !== false && endSeconds - startSeconds >= HOOK_MIN_CLIP_SECONDS && clip.hookStartSeconds !== undefined && clip.hookEndSeconds !== undefined &&
      clip.hookStartSeconds >= startSeconds && clip.hookEndSeconds <= endSeconds
        ? hookToSentence(captions, [Math.max(0, clip.hookStartSeconds - startSeconds - 0.05), clip.hookEndSeconds - startSeconds + 0.15], clipLength)
        : null;
    const keep = hook ? [hook, ...tight] : tight;
    const outLength = keptLength(keep);
    await timer.time("cut", () => cutClip(sourcePath, segmentPath, startSeconds, endSeconds, keep, analysis.hideAreas));
    const captionPages = captionStyle
      ? createTikTokStyleCaptions({
          captions: remapCaptions(captions, keep),
          combineTokensWithinMilliseconds: WORDS_COMBINE_MS[captionStyle.words],
        }).pages
      : [];

    const layout = (userEdit.layout ?? []).map((l) => ({ ...l, fromSeconds: l.fromSeconds - startSeconds, toSeconds: l.toSeconds - startSeconds }));
    const framing = remapFraming(applyLayout(await framingPromise, layout, clipLength), keep);
    const wordsFilename = `render-${runId}-${clip.id}-words.json`;
    await writeFile(path.join(dir, wordsFilename), JSON.stringify(captions));
    await timer.time("render", () => renderClip({
      serveUrl,
      outputPath: outPath,
      videoFileName: `${APP_ORIGIN}/api/analyses/${analysisId}/files/${segment}`,
      trimStartSeconds: 0,
      durationSeconds: outLength,
      title: clip.title,
      captionPages,
      captionStyle,
      framing,
      segmentPath,
      broll: (userEdit.broll ?? []).flatMap((b) =>
        remapFraming([{ fromSeconds: b.fromSeconds - startSeconds, toSeconds: b.toSeconds - startSeconds, mode: "fit", focusX: 50 }], keep).map((r) => ({
          path: path.join(dir, b.file),
          fromSeconds: r.fromSeconds,
          toSeconds: r.toSeconds,
        }))
      ),
      onStart: () => updateRunClip(analysisId, runId, clipId, { renderStartedAt: Date.now(), queueAhead: undefined }),
      onQueue: (ahead) => ahead && updateRunClip(analysisId, runId, clipId, { queueAhead: ahead }),
    })).finally(() => rm(segmentPath, { force: true }).catch(() => {}));
    console.log(`[timing] clip ${clipId.slice(0, 8)}: ${timer.summary()}`);

    await captureThumbnail(outPath, path.join(dir, thumbFilename), outLength);

    updateRunClip(analysisId, runId, clipId, {
      renderStatus: "done",
      renderFinishedAt: Date.now(),
      renderedStartSeconds: startSeconds,
      renderedEndSeconds: endSeconds,
      renderFilename: filename,
      renderThumbnailFilename: thumbFilename,
      wordsFilename,
    });
  } catch (err) {
    const message = err instanceof RenderError || err instanceof MediaError ? err.message : err instanceof Error ? err.message : String(err);
    console.error(`[analysisPipeline] render failed for ${analysisId}/${runId}/${clipId}:`, err);
    updateRunClip(analysisId, runId, clipId, { renderStatus: "error", renderError: message });
  }
}

export function listProviderModels() {
  return listAllProviders();
}
