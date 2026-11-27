import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { existsSync, readdirSync, statSync } from "fs";
import path from "path";
import { getFfmpegPath, getFfprobePath, getYtDlpPath } from "./binaries";

const runFile = promisify(execFile);
// Every external tool gets a time limit, so a stuck process fails the job
// instead of holding it (and the render queue) forever.
const execFileAsync = ((file: string, args: readonly string[], opts: object = {}) =>
  runFile(file, args, { timeout: 30 * 60_000, windowsHide: true, ...opts })) as unknown as typeof runFile;

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
/** The video's title from yt-dlp, or null if it can't be read. */
export async function fetchVideoTitle(url: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(getYtDlpPath(), ["--print", "title", "--skip-download", "--no-playlist", url], {
      windowsHide: true,
      timeout: 30_000,
    });
    return stdout.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

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
  // YouTube sometimes refuses a download outright (HTTP 403), which yt-dlp
  // treats as final; a fresh attempt a few seconds later usually works.
  const waits = [5, 20, 60];
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new CancelledError();
    try {
      return await runDownload(url, outPath, onProgress, signal);
    } catch (err) {
      const refused = err instanceof MediaError && /HTTP 403/.test(err.message);
      if (!refused || attempt >= waits.length) throw err;
      onProgress?.(`YouTube refused the download; retrying in ${waits[attempt]}s\n`);
      await new Promise((r) => setTimeout(r, waits[attempt] * 1000));
    }
  }
}

function runDownload(
  url: string,
  outPath: string,
  onProgress?: (line: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const ytDlp = getYtDlpPath();
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(
      ytDlp,
      [
        url,
        // Cap at 1080p (no size limit: 3-4 h streams are ~7.5 GB): clips never need more, and 4K sources are many times larger.
        // Prefer H.264: Remotion's decoder intermittently lost frames seeking
        // in YouTube's VP9 ("No frame found at position"), failing renders.
        "-f",
        "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b[height<=1080]/b",
        // Fetch DASH/HLS fragments in parallel instead of one at a time.
        "--concurrent-fragments",
        "8",
        // YouTube now and then refuses a request (HTTP 403); a retry usually gets through.
        "--retries",
        "10",
        "--fragment-retries",
        "10",
        "--extractor-retries",
        "3",
        "--ffmpeg-location",
        getFfmpegPath(),
        "--merge-output-format",
        "mp4",
        "-o",
        outPath,
        "--no-playlist",
        // A live stream never finishes downloading.
        "--match-filter",
        "!is_live",
      ],
      { windowsHide: true }
    );
    let stderr = "";
    let cancelled = false;
    let stalled = false;

    // yt-dlp can sit forever on a dead connection; no output for 5 minutes means stuck.
    // Merging a long video's streams prints nothing for many minutes (15 GB
    // took over 5), so files in the folder still growing count as progress.
    let watchdog: NodeJS.Timeout | undefined;
    let lastBytes = -1;
    const growth = setInterval(() => {
      const dir = path.dirname(outPath);
      let bytes = 0;
      try {
        for (const f of readdirSync(dir)) bytes += statSync(path.join(dir, f)).size;
      } catch {
        return;
      }
      if (bytes !== lastBytes) {
        lastBytes = bytes;
        feedWatchdog();
      }
    }, 30_000);
    const feedWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        stalled = true;
        if (proc.pid) killProcessTree(proc.pid);
      }, 5 * 60_000);
    };
    feedWatchdog();

    const onAbort = () => {
      cancelled = true;
      if (proc.pid) killProcessTree(proc.pid);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout?.on("data", (d) => {
      feedWatchdog();
      onProgress?.(d.toString());
    });
    proc.stderr?.on("data", (d) => {
      feedWatchdog();
      stderr += d.toString();
      onProgress?.(d.toString());
    });
    proc.on("error", (err) => {
      clearTimeout(watchdog);
      clearInterval(growth);
      signal?.removeEventListener("abort", onAbort);
      reject(new MediaError(`Failed to launch yt-dlp: ${err.message}`, err));
    });
    proc.on("close", (code) => {
      clearTimeout(watchdog);
      clearInterval(growth);
      signal?.removeEventListener("abort", onAbort);
      if (cancelled) {
        reject(new CancelledError());
      } else if (stalled) {
        reject(new MediaError("The download stopped making progress. Please try again."));
      } else if (code === 0 && !existsSync(outPath)) {
        reject(new MediaError("Live streams can't be made into clips. Try again once the stream has ended."));
      } else if (code === 0) {
        resolve();
      } else {
        console.error(`[media] yt-dlp exited with code ${code}: ${stderr.slice(-2000)}`);
        reject(new MediaError(friendlyDownloadError(stderr)));
      }
    });
  });
}

/** Turns yt-dlp's error output into a sentence a non-technical user can act on. */
function friendlyDownloadError(stderr: string): string {
  const known: [RegExp, string][] = [
    [/HTTP Error 403|403: Forbidden/, "YouTube refused the download (HTTP 403). Please try again in a few minutes."],
    [/Private video/i, "This video is private. Use a public or unlisted video."],
    [/Sign in to confirm your age|age-restricted/i, "This video is age-restricted, so it can't be downloaded. Upload the file instead."],
    [/members-only|Join this channel/i, "This video is for channel members only. Upload the file instead."],
    [/Video unavailable|has been removed|not available/i, "This video is unavailable (removed, blocked or region-locked)."],
    [/Sign in to confirm you.re not a bot/i, "YouTube is temporarily blocking downloads from this server. Try again later or upload the file."],
    [/Unsupported URL|is not a valid URL/i, "That link isn't a video this tool can download. Paste a YouTube link instead."],
    [/File is larger than max-filesize/i, "This video is over 2 GB. Try a shorter video."],
  ];
  const hit = known.find(([pattern]) => pattern.test(stderr));
  const lastLine = stderr.trim().split(/\r?\n/).pop()?.replace(/^ERROR:\s*/, "");
  return hit ? hit[1] : `The video couldn't be downloaded: ${lastLine || "unknown error"}`;
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
  // A header can claim more than the file holds (a retried upload said 47 min
  // for a 30 min file): trust the shorter of the container and the video track.
  const lengths = [parsed.format?.duration, videoStream?.duration]
    .map((d) => (d ? parseFloat(d) : NaN))
    .filter((d) => Number.isFinite(d) && d > 0);
  const durationSeconds = lengths.length ? Math.min(...lengths) : NaN;

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

// Hide-area boxes: one starting this close to the top or bottom edge, no taller
// than MAX_EDGE_CROP, is cropped away; others are blurred.
const EDGE = 0.03;
const MAX_EDGE_CROP = 0.12;

/**
 * Cuts [startSeconds, endSeconds) from the source video into a standalone,
 * re-encoded mp4 at outPath. Re-encoding (rather than stream-copy) guarantees
 * frame-accurate boundaries — stream copy can only cut on keyframes.
 *
 * Used by the pipeline to pre-extract each selected clip's short segment
 * before handing it to Remotion, so OffthreadVideo seeks/decodes within a
 * clip-length file instead of repeatedly seeking into the full (often
 * multi-GB) source for every clip.
 */
export async function cutClip(
  sourcePath: string,
  outPath: string,
  startSeconds: number,
  endSeconds: number,
  /** Pieces to keep, in seconds from startSeconds (see tighten.ts); omitted keeps it all. */
  keep?: Array<[number, number]>,
  /** Boxes to hide (fractions of the frame), e.g. a stream's logo or subscriber counter. */
  hideAreas: Array<{ x: number; y: number; w: number; h: number }> = []
): Promise<void> {
  const ffmpeg = getFfmpegPath();
  const duration = Math.max(0.1, endSeconds - startSeconds);
  // A thin box on the top or bottom edge is cut off (a slight zoom, no trace);
  // any other box is blurred.
  const top = Math.max(0, ...hideAreas.filter((b) => b.y <= EDGE && b.y + b.h <= MAX_EDGE_CROP).map((b) => b.y + b.h));
  const bottom = Math.max(0, ...hideAreas.filter((b) => b.y + b.h >= 1 - EDGE && b.h <= MAX_EDGE_CROP).map((b) => 1 - b.y));
  const hide = hideAreas.filter((b) => !(b.y <= EDGE && b.y + b.h <= MAX_EDGE_CROP) && !(b.y + b.h >= 1 - EDGE && b.h <= MAX_EDGE_CROP));
  // Each blurred box: a heavily blurred copy of that patch laid back over it.
  const px = (v: number) => `trunc(${v.toFixed(4)}*%s/2)*2`;
  const blurGraph = hide
    .map((b, i) => {
      const from = i === 0 ? "[0:v]" : `[h${i}]`;
      const crop = `crop=${px(b.w).replace("%s", "iw")}:${px(b.h).replace("%s", "ih")}:${px(b.x).replace("%s", "iw")}:${px(b.y).replace("%s", "ih")}`;
      return `${from}split[m${i}][p${i}];[p${i}]${crop},boxblur=luma_radius=20:luma_power=3[b${i}];` +
        `[m${i}][b${i}]overlay=${px(b.x).replace("%s", "W")}:${px(b.y).replace("%s", "H")}[h${i + 1}];`;
    })
    .join("");
  const blurred = hide.length ? `[h${hide.length}]` : "[0:v]";
  const cropped = top + bottom > 0;
  const hideGraph = blurGraph + (cropped ? `${blurred}crop=iw:${px(1 - top - bottom).replace("%s", "ih")}:0:${px(top).replace("%s", "ih")}[hc];` : "");
  const video = cropped ? "[hc]" : blurred;
  const anyHidden = hide.length > 0 || cropped;
  // A 15 ms fade on each side of every cut so joins don't click.
  const pieces = keep && keep.length > 1 ? keep : null;
  const joins = pieces
    ? [
          "-filter_complex",
          hideGraph +
          (anyHidden ? `${video}split=${pieces.length}${pieces.map((_, i) => `[s${i}]`).join("")};` : "") +
          pieces
            .map(([s, e], i) => {
              const fadeOut = Math.max(0, e - s - 0.015).toFixed(3);
              return `${anyHidden ? `[s${i}]` : "[0:v]"}trim=${s.toFixed(3)}:${e.toFixed(3)},setpts=PTS-STARTPTS[v${i}];` +
                `[0:a]atrim=${s.toFixed(3)}:${e.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.015,afade=t=out:st=${fadeOut}:d=0.015[a${i}];`;
            })
            .join("") + `${pieces.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${pieces.length}:v=1:a=1[v][a]`,
          "-map", "[v]", "-map", "[a]",
        ]
    : anyHidden
      ? ["-filter_complex", hideGraph.replace(/;$/, ""), "-map", video, "-map", "0:a?"]
      : [];
  try {
    await execFileAsync(ffmpeg, [
      "-y",
      "-ss",
      startSeconds.toFixed(2),
      "-i",
      sourcePath,
      "-t",
      duration.toFixed(2),
      ...joins,
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
