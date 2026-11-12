import path from "path";
import { copyFile, mkdir, rm } from "fs/promises";
import { createTikTokStyleCaptions } from "@remotion/captions";
import {
  downloadVideo,
  probeVideo,
  extractAudioSegment,
  captureThumbnail,
  cutClip,
  isYoutubeUrl,
  MediaError,
  CancelledError,
} from "./media";
import { uploadVideo, analyzeWindow, analyzeTranscript, rankCandidates, GeminiError, type RawCandidate } from "./gemini";
import { extractYoutubeTranscript, TranscriptError } from "./transcript";
import { validateClips } from "./validation";
import { createLimiter } from "./limit";
import type { TranscriptSegment } from "./transcript";
import { clipLengthRange, type ClipLengthPreset } from "./clipLength";
import { transcribeWav, WhisperError } from "./whisper";
import { bundleForJob, renderClip, RenderError } from "./render";
import { analyzeFraming } from "./framing";
import { ensureJobDir, updateJob, registerController, unregisterController, type JobClip } from "./jobs";
import { StageTimer } from "./timing";

// A transcript-derived clip needs a reasonable density of covering words to
// be trustworthy as caption source — below this we fall back to Whisper
// rather than show sparse/misleading captions.

const WINDOW_SECONDS = 5 * 60; // 5-minute analysis windows
const WINDOW_OVERLAP_SECONDS = 20; // avoid missing hooks that straddle a window boundary
const TARGET_CLIP_COUNT = 5;

export interface RunPipelineInput {
  jobId: string;
  /** Either a URL to download, or a local path to an already-uploaded file. */
  source: { kind: "url"; url: string } | { kind: "file"; path: string };
  clipLength?: ClipLengthPreset;
}

export async function runPipeline({ jobId, source, clipLength }: RunPipelineInput): Promise<void> {
  const controller = new AbortController();
  registerController(jobId, controller);
  const signal = controller.signal;
  const checkCancelled = () => {
    if (signal.aborted) throw new CancelledError();
  };

  const timer = new StageTimer(jobId);
  const lengthRange = clipLengthRange(clipLength);

  try {
    const dir = await ensureJobDir(jobId);
    const sourcePath = path.join(dir, "source.mp4");

    if (source.kind === "url") {
      updateJob(jobId, { status: "downloading", progressMessage: `Downloading video from ${source.url}` });
      await timer.time("download", () =>
        downloadVideo(
          source.url,
          sourcePath,
          (line) => {
            updateJob(jobId, { progressMessage: `Downloading… ${line.trim().slice(-120)}` });
          },
          signal
        )
      );
    } else {
      updateJob(jobId, { status: "downloading", progressMessage: "Saving uploaded file" });
      await timer.time("download", () => copyFile(source.path, sourcePath));
    }

    checkCancelled();
    updateJob(jobId, { status: "probing", progressMessage: "Reading video metadata" });
    const probe = await timer.time("probe", () => probeVideo(sourcePath));
    updateJob(jobId, { videoDurationSeconds: probe.durationSeconds });

    if (probe.durationSeconds < 30) {
      throw new PipelineError("Video is too short to extract meaningful clips (minimum 30 seconds).");
    }
    if (!probe.hasAudio) {
      throw new PipelineError("Video has no audio track — hook detection relies on spoken content.");
    }

    checkCancelled();
    const allCandidates: Array<RawCandidate & { absoluteStart: number; absoluteEnd: number }> = [];
    let usedTranscript = false;

    // YouTube-specific fast path: YouTube's own captions give us an accurate,
    // officially-sourced transcript for free — analyzing that text directly
    // is faster and cheaper than uploading the whole video to Gemini and
    // scanning it in windows. Falls back to the video-analysis path below if
    // the video has no captions at all (never fabricates a transcript).
    let transcriptSegments: TranscriptSegment[] | undefined;
    if (source.kind === "url" && isYoutubeUrl(source.url)) {
      updateJob(jobId, { status: "analyzing", progressMessage: "Fetching YouTube transcript" });
      const transcriptDir = path.join(dir, "transcript-tmp");
      await mkdir(transcriptDir, { recursive: true });
      try {
        const transcript = await timer.time("transcript_fetch", () =>
          extractYoutubeTranscript(source.url, transcriptDir)
        );
        updateJob(jobId, {
          progressMessage: `Analyzing transcript (${transcript.segments.length} segments, ${transcript.source} captions)`,
        });
        const candidates = await timer.time("analyze", () => analyzeTranscript(transcript.segments, TARGET_CLIP_COUNT, lengthRange));
        for (const c of candidates) {
          allCandidates.push({ ...c, absoluteStart: c.startSeconds, absoluteEnd: c.endSeconds });
        }
        usedTranscript = true;
        transcriptSegments = transcript.segments;
      } catch (err) {
        if (err instanceof TranscriptError) {
          console.error(`[pipeline] transcript extraction failed, falling back to video analysis:`, err.message);
        } else {
          throw err;
        }
      }
    }

    if (!usedTranscript) {
      checkCancelled();
      updateJob(jobId, { status: "uploading", progressMessage: "Uploading video to Gemini for analysis" });
      const geminiFile = await timer.time("upload", () => uploadVideo(sourcePath, "video/mp4"));

      updateJob(jobId, { status: "analyzing", progressMessage: "Scanning video for hook moments" });
      const windows = buildWindows(probe.durationSeconds);

      for (let i = 0; i < windows.length; i++) {
        checkCancelled();
        const [windowStart, windowEnd] = windows[i];
        updateJob(jobId, {
          progressMessage: `Scanning for hooks… window ${i + 1}/${windows.length} (${Math.round(windowStart)}s-${Math.round(windowEnd)}s)`,
        });
        let candidates: RawCandidate[];
        try {
          candidates = await timer.time(`analyze_window_${i + 1}`, () => analyzeWindow(geminiFile, windowStart, windowEnd, lengthRange));
        } catch (err) {
          // One bad window shouldn't kill the whole job — log and continue.
          console.error(`[pipeline] window [${windowStart}-${windowEnd}] analysis failed:`, err);
          continue;
        }
        for (const c of candidates) {
          allCandidates.push({
            ...c,
            absoluteStart: windowStart + c.startSeconds,
            absoluteEnd: windowStart + c.endSeconds,
          });
        }
      }
    }

    if (allCandidates.length === 0) {
      throw new PipelineError(
        "Gemini found no hook-worthy moments in this video. This can happen with low-energy content, poor audio, or very narrow subject matter."
      );
    }

    checkCancelled();
    updateJob(jobId, { status: "ranking", progressMessage: `Ranking ${allCandidates.length} candidate moments` });
    const ranked = await timer.time("rank", () => rankCandidates(allCandidates, TARGET_CLIP_COUNT, lengthRange));
    const validated = validateClips(
      ranked.map((r) => ({ ...r, startSeconds: r.startSeconds, endSeconds: r.endSeconds })),
      probe.durationSeconds,
      lengthRange,
      transcriptSegments
    );

    if (validated.length === 0) {
      throw new PipelineError("Gemini's picks did not pass validation (bad timestamps or clip lengths). Try again or use a different video.");
    }

    updateJob(jobId, { status: "cutting", progressMessage: `Preparing render pipeline for ${validated.length} clips` });

    // Pre-extract every selected clip's video into a short, standalone file
    // BEFORE bundling Remotion. bundle()'s publicDir is a one-time snapshot
    // copy, not a live file server — a file created after bundling is never
    // visible to the render server (staticFile() 404s). Cutting all segments
    // first means the bundle snapshot already contains every clip-N-segment.mp4,
    // and Remotion's OffthreadVideo then seeks/decodes within clip-length
    // files instead of repeatedly seeking into the full (often multi-GB)
    // source for every one of the N clips. Accurate re-encode (not
    // stream-copy) is used so the cut boundary matches the hook timing
    // Gemini/transcript chose exactly, rather than snapping to the nearest
    // keyframe.
    // The cuts are independent ffmpeg runs, so do them all at once.
    checkCancelled();
    updateJob(jobId, { progressMessage: `Extracting ${validated.length} segments` });
    const segments = await Promise.all(
      validated.map(async (v, i) => {
        const segmentFilename = `clip-${i + 1}-segment.mp4`;
        const segmentPath = path.join(dir, segmentFilename);
        await timer.time(`extract_segment_${i + 1}`, () => cutClip(sourcePath, segmentPath, v.startSeconds, v.endSeconds));
        return { filename: segmentFilename, path: segmentPath };
      })
    );

    // publicDir = the job's own storage dir, which now holds source.mp4 and
    // every pre-extracted segment — this lets the Remotion composition load
    // each one via staticFile(filename) without us relying on undocumented
    // local-file-path behavior in OffthreadVideo.
    const serveUrl = await timer.time("remotion_bundle", () => bundleForJob(dir));

    // Captions (Whisper, GPU) and framing (CPU) don't depend on rendering, so
    // they run for upcoming clips while earlier clips render, instead of the
    // whole job waiting clip by clip. Two at a time keeps the GPU from thrashing.
    const prepLimit = createLimiter(2);
    const preps = validated.map((v, i) =>
      prepLimit(async () => {
        const clipLength = v.endSeconds - v.startSeconds;
        const wavPath = path.join(dir, `clip-${i + 1}-audio.wav`);
        const { path: segmentPath } = segments[i];
        // Face-aware crop runs alongside captions (it's independent of them).
        // Like captions it's an enhancement: on failure the clip is letterboxed.
        const framingPromise = timer.time(`framing_${i + 1}`, () => analyzeFraming(segmentPath)).catch((err) => {
          console.error(`[pipeline] framing analysis failed for clip ${i + 1}:`, err);
          return [];
        });
        let captionPages: ReturnType<typeof createTikTokStyleCaptions>["pages"] = [];
        try {
          // Always transcribe the clip's own audio. YouTube caption text was
          // reused here before, but it has no per-word timing or spacing (the
          // whole clip collapsed into one giant caption page) and for Hinglish
          // videos it's often an English translation, not what was said.
          const captions = await timer.time(`captions_${i + 1}`, async () => {
            await extractAudioSegment(segmentPath, wavPath, 0, clipLength);
            return transcribeWav(wavPath);
          });
          captionPages = createTikTokStyleCaptions({
            captions,
            combineTokensWithinMilliseconds: 1200,
          }).pages;
        } catch (err) {
          // Captions are an enhancement, not a hard requirement — a clip without
          // captions is still a usable output, so we degrade gracefully instead
          // of failing the whole job over a transcription hiccup.
          console.error(`[pipeline] caption generation failed for clip ${i + 1}:`, err);
        }
        return { captionPages, framing: await framingPromise };
      })
    );

    const clips: JobClip[] = [];
    for (let i = 0; i < validated.length; i++) {
      checkCancelled();
      const v = validated[i];
      const clipLength = v.endSeconds - v.startSeconds;
      const filename = `clip-${i + 1}.mp4`;
      const outPath = path.join(dir, filename);
      const wavPath = path.join(dir, `clip-${i + 1}-audio.wav`);
      const { filename: segmentFilename, path: segmentPath } = segments[i];

      updateJob(jobId, { progressMessage: `Preparing captions for clip ${i + 1}/${validated.length}: "${v.title}"` });
      const { captionPages, framing } = await preps[i];

      updateJob(jobId, { progressMessage: `Rendering clip ${i + 1}/${validated.length}: "${v.title}"` });
      const renderOnce = () =>
        renderClip({
          serveUrl,
          outputPath: outPath,
          videoFileName: segmentFilename,
          // The segment file already starts exactly at v.startSeconds, so
          // Remotion trims from its own beginning rather than re-seeking to
          // the original absolute offset in the full source.
          trimStartSeconds: 0,
          durationSeconds: clipLength,
          title: v.title,
          captionPages,
          framing,
          onProgress: (progress) => {
            updateJob(jobId, {
              progressMessage: `Rendering clip ${i + 1}/${validated.length}: "${v.title}" (${Math.round(progress * 100)}%)`,
            });
          },
        });

      let rendered = false;
      try {
        await timer.time(`render_${i + 1}`, renderOnce);
        rendered = true;
      } catch (err) {
        // Transient resource contention (e.g. the timeout we saw under real
        // load with multiple renders competing for CPU) is worth one retry
        // before we give up on this clip and move on.
        console.error(`[pipeline] render failed for clip ${i + 1}, retrying once:`, err);
        try {
          await timer.time(`render_${i + 1}_retry`, renderOnce);
          rendered = true;
        } catch (retryErr) {
          console.error(`[pipeline] render retry also failed for clip ${i + 1}, skipping:`, retryErr);
        }
      }

      // The pre-extracted segment and per-clip audio are intermediates only
      // needed up to this point — clean them up regardless of render outcome
      // so a long job doesn't accumulate multiple full-size temp files
      // (whole-job-dir cleanup on cancel/delete still covers the rest).
      await rm(segmentPath, { force: true }).catch(() => {});
      await rm(wavPath, { force: true }).catch(() => {});

      if (!rendered) continue; // skip this clip, keep the rest of the job moving

      let thumbnailFilename: string | undefined;
      try {
        thumbnailFilename = `clip-${i + 1}-thumb.jpg`;
        await captureThumbnail(outPath, path.join(dir, thumbnailFilename), clipLength);
      } catch (err) {
        console.error(`[pipeline] thumbnail capture failed for clip ${i + 1}:`, err);
        thumbnailFilename = undefined;
      }

      clips.push({
        id: `${jobId}-${i + 1}`,
        startSeconds: v.startSeconds,
        endSeconds: v.endSeconds,
        title: v.title,
        reason: v.reason,
        score: v.score,
        filename,
        thumbnailFilename,
      });
      // Persist clips incrementally rather than only at the very end, so the
      // library view can show finished clips while later ones are still
      // rendering (and so progress isn't lost if the job fails partway).
      updateJob(jobId, { clips: [...clips] });
    }

    if (clips.length === 0) {
      throw new PipelineError("All clip renders failed. See server logs for the underlying ffmpeg/Remotion errors.");
    }

    console.log(`[timing] job=${jobId} summary ${timer.summary()}`);
    updateJob(jobId, { status: "done", progressMessage: "Done", clips });
  } catch (err) {
    if (err instanceof CancelledError) {
      // Status was already set to "cancelled" by requestCancel() — nothing
      // more to do, and we must not overwrite it with an "error" state.
      return;
    }
    const message =
      err instanceof PipelineError ||
      err instanceof MediaError ||
      err instanceof GeminiError ||
      err instanceof WhisperError ||
      err instanceof RenderError
        ? err.message
        : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[pipeline] job ${jobId} failed:`, err);
    updateJob(jobId, { status: "error", progressMessage: message, error: message });
  } finally {
    unregisterController(jobId);
  }
}

class PipelineError extends Error {}

function buildWindows(durationSeconds: number): Array<[number, number]> {
  const windows: Array<[number, number]> = [];
  let start = 0;
  while (start < durationSeconds) {
    const end = Math.min(start + WINDOW_SECONDS, durationSeconds);
    windows.push([start, end]);
    if (end >= durationSeconds) break;
    start = end - WINDOW_OVERLAP_SECONDS;
  }
  return windows;
}
