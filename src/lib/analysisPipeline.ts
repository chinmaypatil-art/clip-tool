import path from "path";
import { copyFile, rm } from "fs/promises";
import { createTikTokStyleCaptions } from "@remotion/captions";
import { randomUUID } from "crypto";
import { createLimiter } from "./limit";
import { processSingleton } from "./processState";
import { ensureOllama } from "./ollamaHealth";
import { parseCaptionStyle, WORDS_COMBINE_MS } from "./captionStyle";
import { fetchVideoTitle, downloadVideo, probeVideo, extractAudioSegment, captureThumbnail, cutClip, findSilences, isYoutubeUrl, isUrl, MediaError } from "./media";
import { extractYoutubeTranscript, captionsToSegments, referenceText, TranscriptError } from "./transcript";
import { transcribeWav, WhisperError } from "./whisper";
import { bundleForJob, renderClip, RenderError } from "./render";
import { analyzeFraming } from "./framing";
import { runAnalysis, listAllProviders, getLocalRomanizer, getLocalEndChecker, getLocalWindowedPicker } from "./providers/registry";
import { ANALYSIS_PROMPT_VERSION, ProviderError, type EndChecker } from "./providers/types";
import {
  ensureAnalysisDir,
  analysisDir,
  updateAnalysis,
  addRun,
  updateRun,
  updateRunClip,
  getAnalysis,
  type ModelRun,
  type AnalysisClip,
} from "./analyses";
import type { Provider } from "./keystore";
import { clipLengthRange, type ClipLengthPreset, type ClipLengthRange } from "./clipLength";
import type { TranscriptSegment } from "./transcript";
import { trimTrailingQuestion, fitToMaxLength, snapToSentences, endContext, snapToSilence, reachMinLength } from "./clipTrim";

export class AnalysisPipelineError extends Error {}

// Picks this far under the chosen minimum are still kept (see validation.ts).
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
const MAX_VIDEO_SECONDS = 3 * 3600;

/**
 * Whole-video Whisper and Gemma's picking each fill most of the GPU; when two
 * people submit at once, the second waits instead of both running out of
 * memory. (Per-clip work during rendering is short and isn't gated.)
 */
const gpuSlot = processSingleton("gpuSlot", () => createLimiter(1));

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
      await downloadVideo(source.url, sourcePath, () => {});
    } else {
      await copyFile(source.path, sourcePath);
    }
    updateAnalysis(analysisId, { downloadedAt: Date.now() });

    const probe = await probeVideo(sourcePath);
    if (probe.durationSeconds < 30) {
      throw new AnalysisPipelineError("Video is too short to extract meaningful clips (minimum 30 seconds).");
    }
    if (probe.durationSeconds > MAX_VIDEO_SECONDS) {
      throw new AnalysisPipelineError("This video is over 3 hours long. Please use a shorter video or cut it into parts.");
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
    const captions = await gpuSlot(() => transcribeWav(wavPath, { romanizer: null }));
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

const TARGET_CLIP_COUNT = 5;

/** The model the one-click flow picks clips with. */
export const CLIP_PICKER = {
  provider: (process.env.CLIP_PROVIDER ?? "ollama-local") as Provider,
  model: process.env.CLIP_MODEL ?? "gemma3:12b",
};

/**
 * The one-click flow: video in, rendered clips out. Transcript, then the
 * local model picks clips, then every clip renders. Two clips are in flight at
 * once, so one clip's captions are made while the other renders.
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

  await runModelAgainstAnalysis(analysisId, CLIP_PICKER.provider, CLIP_PICKER.model, analysis.clipLength);
  const run = getAnalysis(analysisId)?.runs.at(-1);
  if (run?.status !== "done") return;

  const inFlight = createLimiter(2);
  await Promise.all(run.clips.map((clip) => inFlight(() => renderAnalysisClip(analysisId, run.id, clip.id))));
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
      })
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
}: {
  provider: Provider;
  model: string;
  segments: TranscriptSegment[];
  durationSeconds: number;
  range: ClipLengthRange;
  sourcePath: string;
}) {
  // Local models read the transcript a few minutes at a time; cloud models
  // (the benchmark) still get it whole in one call.
  const windowed = await getLocalWindowedPicker(provider, model);
  const result = windowed
    ? {
        ...(await windowed({ segments, targetCount: TARGET_CLIP_COUNT, range })),
        meta: { keyId: "local", keyLabel: "local (no key)", attempts: 1 },
      }
    : await runAnalysis(provider, model, segments, TARGET_CLIP_COUNT, range);
  const minPick = windowed ? Math.min(LOCAL_MIN_MOMENT_SECONDS, range.minSeconds * SHORT_TOLERANCE) : range.minSeconds * SHORT_TOLERANCE;
  const picked = keepBest(clampAndDedupe(result.clips, durationSeconds, range, segments, minPick), TARGET_CLIP_COUNT);
  const clips = await refineEdges(picked, range, segments, sourcePath, await getLocalEndChecker(provider, model));
  return { ...result, clips };
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
    const long = reachMinLength(start, clampedEnd, range.minSeconds, durationSeconds, MAX_SETUP_SECONDS);
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
        if (newEnd > startSeconds + 3 && newEnd - startSeconds <= range.maxSeconds && newEnd < nextStart) {
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
      const snapped = snapToSilence(startSeconds, endSeconds, { ...range, minSeconds: shortestClip(range) }, silences);
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

    // Face-aware crop, computed alongside captions; letterbox if it fails.
    const framingPromise = analyzeFraming(sourcePath, startSeconds, clipLength).catch((err) => {
      console.error(`[analysisPipeline] framing analysis failed for ${analysisId}/${runId}/${clipId}:`, err);
      return [];
    });

    // Older analyses have no setting and keep the default captions.
    const captionStyle = analysis.captionStyle === null ? null : parseCaptionStyle(analysis.captionStyle);
    let captionPages: ReturnType<typeof createTikTokStyleCaptions>["pages"] = [];
    try {
      if (captionStyle) {
        await extractAudioSegment(sourcePath, wavPath, startSeconds, clipLength);
        const captions = await transcribeWav(wavPath, {
          romanizer: await getLocalRomanizer(run.provider, run.model),
          reference: referenceText(analysis.transcript?.segments, startSeconds, startSeconds + clipLength),
        });
        captionPages = createTikTokStyleCaptions({
          captions,
          combineTokensWithinMilliseconds: WORDS_COMBINE_MS[captionStyle.words],
        }).pages;
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
    await cutClip(sourcePath, segmentPath, startSeconds, endSeconds);

    await renderClip({
      serveUrl,
      outputPath: outPath,
      videoFileName: `${APP_ORIGIN}/api/analyses/${analysisId}/files/${segment}`,
      trimStartSeconds: 0,
      durationSeconds: clipLength,
      title: clip.title,
      captionPages,
      captionStyle,
      framing: await framingPromise,
      segmentPath,
      onStart: () => updateRunClip(analysisId, runId, clipId, { renderStartedAt: Date.now() }),
    }).finally(() => rm(segmentPath, { force: true }).catch(() => {}));

    await captureThumbnail(outPath, path.join(dir, thumbFilename), clipLength);

    updateRunClip(analysisId, runId, clipId, {
      renderStatus: "done",
      renderFinishedAt: Date.now(),
      renderedStartSeconds: startSeconds,
      renderedEndSeconds: endSeconds,
      renderFilename: filename,
      renderThumbnailFilename: thumbFilename,
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
