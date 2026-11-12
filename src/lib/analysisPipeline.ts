import path from "path";
import { copyFile } from "fs/promises";
import { createTikTokStyleCaptions } from "@remotion/captions";
import { randomUUID } from "crypto";
import { downloadVideo, probeVideo, extractAudioSegment, captureThumbnail, isYoutubeUrl, isUrl, MediaError } from "./media";
import { extractYoutubeTranscript, captionsToSegments, TranscriptError } from "./transcript";
import { transcribeWav, WhisperError } from "./whisper";
import { bundleForJob, renderClip, RenderError } from "./render";
import { analyzeFraming } from "./framing";
import { runAnalysis, listAllProviders, getLocalRomanizer } from "./providers/registry";
import { ProviderError } from "./providers/types";
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
import { trimTrailingQuestion, fitToMaxLength, snapToSentences } from "./clipTrim";

export class AnalysisPipelineError extends Error {}

const ANALYSIS_PROMPT_VERSION = "v1";
// Picks this far under the chosen minimum are still kept (see validation.ts).
const SHORT_TOLERANCE = 0.6;

/**
 * Downloads the source (needed later for rendering regardless of path) and
 * extracts a transcript: YouTube captions for YouTube URLs, or a full-video
 * Whisper transcription for everything else. Every model run against this
 * analysis uses this exact same transcript — required for a fair comparison.
 */
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
    const captions = await transcribeWav(wavPath, { romanizer: null });
    const segments = captionsToSegments(captions);
    updateAnalysis(analysisId, {
      status: "ready",
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
    clips: [],
    rawResponse: null,
  };
  addRun(analysisId, run);

  try {
    const range = clipLengthRange(clipLength);
    const result = await runAnalysis(provider, model, analysis.transcript.segments, TARGET_CLIP_COUNT, range);
    const clips = clampAndDedupe(result.clips, analysis.videoDurationSeconds ?? Infinity, range, analysis.transcript.segments).map(
      (c): AnalysisClip => ({ ...c, id: randomUUID(), renderStatus: "pending" })
    );

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

function clampAndDedupe<T extends { startSeconds: number; endSeconds: number; viralScore: number }>(
  clips: T[],
  durationSeconds: number,
  range: ClipLengthRange,
  segments?: TranscriptSegment[]
): T[] {
  const cleaned: T[] = [];
  for (const clip of clips) {
    if (!Number.isFinite(clip.startSeconds) || !Number.isFinite(clip.endSeconds)) continue;
    const start = Math.max(0, Math.min(clip.startSeconds, durationSeconds));
    const end = trimTrailingQuestion(start, Math.max(0, Math.min(clip.endSeconds, durationSeconds)), segments);
    const length = end - start;
    if (length < range.minSeconds * SHORT_TOLERANCE) continue;
    const clampedEnd = fitToMaxLength(start, end, range.maxSeconds, range.minSeconds * SHORT_TOLERANCE, segments);
    const snapped = snapToSentences(start, clampedEnd, range.maxSeconds, segments);
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

const serveUrlCache = new Map<string, string>();

/** Renders one clip from one model run, reusing the existing Remotion pipeline unchanged. */
export async function renderAnalysisClip(analysisId: string, runId: string, clipId: string): Promise<void> {
  const analysis = getAnalysis(analysisId);
  const run = analysis?.runs.find((r) => r.id === runId);
  const clip = run?.clips.find((c) => c.id === clipId);
  if (!analysis || !run || !clip) throw new AnalysisPipelineError("Clip not found.");

  updateRunClip(analysisId, runId, clipId, { renderStatus: "rendering" });

  try {
    const dir = analysisDir(analysisId);
    const sourcePath = path.join(dir, "source.mp4");
    const clipLength = clip.endSeconds - clip.startSeconds;
    const filename = `render-${runId}-${clip.id}.mp4`;
    const thumbFilename = `render-${runId}-${clip.id}-thumb.jpg`;
    const outPath = path.join(dir, filename);
    const wavPath = path.join(dir, `render-${runId}-${clip.id}-audio.wav`);

    // Face-aware crop, computed alongside captions; letterbox if it fails.
    const framingPromise = analyzeFraming(sourcePath, clip.startSeconds, clipLength).catch((err) => {
      console.error(`[analysisPipeline] framing analysis failed for ${analysisId}/${runId}/${clipId}:`, err);
      return [];
    });

    let captionPages: ReturnType<typeof createTikTokStyleCaptions>["pages"] = [];
    try {
      await extractAudioSegment(sourcePath, wavPath, clip.startSeconds, clipLength);
      const captions = await transcribeWav(wavPath, { romanizer: await getLocalRomanizer(run.provider, run.model) });
      captionPages = createTikTokStyleCaptions({ captions, combineTokensWithinMilliseconds: 1200 }).pages;
    } catch (err) {
      console.error(`[analysisPipeline] caption generation failed for ${analysisId}/${runId}/${clipId}:`, err);
    }

    let serveUrl = serveUrlCache.get(analysisId);
    if (!serveUrl) {
      serveUrl = await bundleForJob(dir);
      serveUrlCache.set(analysisId, serveUrl);
    }

    await renderClip({
      serveUrl,
      outputPath: outPath,
      videoFileName: "source.mp4",
      trimStartSeconds: clip.startSeconds,
      durationSeconds: clipLength,
      title: clip.title,
      captionPages,
      framing: await framingPromise,
    });

    await captureThumbnail(outPath, path.join(dir, thumbFilename), clipLength);

    updateRunClip(analysisId, runId, clipId, {
      renderStatus: "done",
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
