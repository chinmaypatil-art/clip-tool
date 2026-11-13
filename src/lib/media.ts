import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { getFfmpegPath, getFfprobePath, getYtDlpPath } from "./binaries";

const execFileAsync = promisify(execFile);

export class MediaError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "MediaError";
  }
}

export class CancelledError extends Error {
  constructor(message = "Cancelled by user") {
    super(message);
    this.name = "CancelledError";
  }
}

/**
 * Kills a process and its full descendant tree. Needed on Windows because
 * yt-dlp spawns a child ffmpeg process to merge streams, and a plain
 * SIGTERM/kill() only terminates the direct child, leaving ffmpeg running
 * and the partial output file locked.
 */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // process already gone
      }
    }
  }
}

/** Returns true if the string looks like an http(s) URL rather than a local path. */
export function isUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);

export function isYoutubeUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return YOUTUBE_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Downloads a video from a URL (YouTube, Instagram, TikTok, Facebook, direct
 * podcast/audio links, etc. — anything yt-dlp supports) to a local mp4.
 * Spotify is explicitly unsupported (DRM-protected; yt-dlp cannot fetch it).
 */
export async function downloadVideo(
  url: string,
  outPath: string,
  onProgress?: (line: string) => void,
  signal?: AbortSignal
): Promise<void> {
  if (/open\.spotify\.com/i.test(url)) {
    throw new MediaError(
      "Spotify links are not supported — Spotify streams are DRM-protected and cannot be downloaded. Use a direct podcast RSS/MP3 link, YouTube, Instagram, TikTok, or Facebook instead."
    );
  }
  if (signal?.aborted) throw new CancelledError();

  const ytDlp = getYtDlpPath();
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      ytDlp,
      [
        url,
        // Cap at 1080p: clips never need more, and 4K sources are many times larger.
        // Prefer H.264: Remotion's decoder intermittently lost frames seeking
        // in YouTube's VP9 ("No frame found at position"), failing renders.
        "-f",
        "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b[height<=1080]/b",
        // Fetch DASH/HLS fragments in parallel instead of one at a time.
        "--concurrent-fragments",
        "8",
        "--ffmpeg-location",
        getFfmpegPath(),
        "--merge-output-format",
        "mp4",
        "-o",
        outPath,
        "--no-playlist",
        "--max-filesize",
        "2G",
      ],
      { windowsHide: true }
    );
    let stderr = "";
    let cancelled = false;

    const onAbort = () => {
      cancelled = true;
      if (proc.pid) killProcessTree(proc.pid);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout?.on("data", (d) => onProgress?.(d.toString()));
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
      onProgress?.(d.toString());
    });
    proc.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(new MediaError(`Failed to launch yt-dlp: ${err.message}`, err));
    });
    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (cancelled) {
        reject(new CancelledError());
      } else if (code === 0) {
        resolve();
      } else {
        reject(new MediaError(`yt-dlp exited with code ${code}: ${stderr.slice(-2000)}`));
      }
    });
  });
}

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

/** Probes a local media file for duration/dimensions using ffprobe. Throws if the file isn't valid media. */
export async function probeVideo(filePath: string): Promise<ProbeResult> {
  const ffprobe = getFfprobePath();
  let stdout: string;
  try {
    const result = await execFileAsync(ffprobe, [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ]);
    stdout = result.stdout;
  } catch (err) {
    throw new MediaError(`ffprobe failed to read "${filePath}" — file may be corrupt or not a valid video.`, err);
  }

  let parsed: {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
  };
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new MediaError("ffprobe returned unparseable output.", err);
  }

  const videoStream = parsed.streams?.find((s) => s.codec_type === "video");
  const audioStream = parsed.streams?.find((s) => s.codec_type === "audio");
  const durationStr = parsed.format?.duration ?? videoStream?.duration;
  const durationSeconds = durationStr ? parseFloat(durationStr) : NaN;

  if (!videoStream || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new MediaError(`"${filePath}" does not appear to contain a valid video stream.`);
  }

  return {
    durationSeconds,
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
    hasAudio: Boolean(audioStream),
  };
}

/**
 * Extracts [startSeconds, startSeconds+durationSeconds) of audio from a video
 * as 16kHz mono WAV — whisper.cpp's required input format. Used to transcribe
 * just one clip's audio rather than the whole source video.
 */
export async function extractAudioSegment(
  sourcePath: string,
  outWavPath: string,
  startSeconds: number,
  durationSeconds: number
): Promise<void> {
  const ffmpeg = getFfmpegPath();
  try {
    await execFileAsync(ffmpeg, [
      "-y",
      "-ss",
      startSeconds.toFixed(2),
      "-i",
      sourcePath,
      "-t",
      durationSeconds.toFixed(2),
      "-ar",
      "16000",
      "-ac",
      "1",
      outWavPath,
    ]);
  } catch (err) {
    throw new MediaError(
      `ffmpeg failed to extract audio segment [${startSeconds}s, +${durationSeconds}s] from "${sourcePath}".`,
      err
    );
  }
}

/** Captures a single JPEG frame from the middle of a clip, for use as a library/history thumbnail. */
export async function captureThumbnail(clipPath: string, outJpgPath: string, clipDurationSeconds: number): Promise<void> {
  const ffmpeg = getFfmpegPath();
  const atSeconds = Math.max(0, Math.min(clipDurationSeconds / 2, clipDurationSeconds - 0.1));
  try {
    await execFileAsync(ffmpeg, [
      "-y",
      "-ss",
      atSeconds.toFixed(2),
      "-i",
      clipPath,
      "-frames:v",
      "1",
      "-q:v",
      "4",
      outJpgPath,
    ]);
  } catch (err) {
    throw new MediaError(`ffmpeg failed to capture a thumbnail from "${clipPath}".`, err);
  }
}

/**
 * Cuts [startSeconds, endSeconds) from the source video into a standalone,
 * re-encoded mp4 at outPath. Re-encoding (rather than stream-copy) guarantees
 * frame-accurate boundaries — stream copy can only cut on keyframes.
 *
 * Used by the pipeline to pre-extract each selected clip's short segment
 * before handing it to Remotion, so OffthreadVideo seeks/decodes within a
 * clip-length file instead of repeatedly seeking into the full (often
 * multi-GB) source for every one of the 5 clips.
 */
export async function cutClip(
  sourcePath: string,
  outPath: string,
  startSeconds: number,
  endSeconds: number
): Promise<void> {
  const ffmpeg = getFfmpegPath();
  const duration = Math.max(0.1, endSeconds - startSeconds);
  try {
    await execFileAsync(ffmpeg, [
      "-y",
      "-ss",
      startSeconds.toFixed(2),
      "-i",
      sourcePath,
      "-t",
      duration.toFixed(2),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      outPath,
    ]);
  } catch (err) {
    throw new MediaError(
      `ffmpeg failed to cut clip [${startSeconds}s-${endSeconds}s] from "${sourcePath}".`,
      err
    );
  }
}

/**
 * Pauses (at least `minSeconds` below -35 dB) in [fromSeconds, toSeconds) of a
 * file's audio, in absolute seconds. Used to put clip edges where nobody is
 * talking; transcript timings alone are a second or two off.
 */
export async function findSilences(
  filePath: string,
  fromSeconds: number,
  toSeconds: number,
  minSeconds = 0.25
): Promise<Array<{ start: number; end: number }>> {
  const from = Math.max(0, fromSeconds);
  const { stderr } = await execFileAsync(getFfmpegPath(), [
    "-hide_banner",
    "-ss",
    from.toFixed(2),
    "-t",
    Math.max(0.1, toSeconds - from).toFixed(2),
    "-i",
    filePath,
    "-vn",
    "-af",
    `silencedetect=n=-35dB:d=${minSeconds}`,
    "-f",
    "null",
    "-",
  ]);
  const silences: Array<{ start: number; end: number }> = [];
  let open: number | null = null;
  for (const m of stderr.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    const t = from + Math.max(0, parseFloat(m[2]));
    if (m[1] === "start") open = t;
    else if (open !== null) {
      silences.push({ start: open, end: t });
      open = null;
    }
  }
  if (open !== null) silences.push({ start: open, end: toSeconds });
  return silences;
}
