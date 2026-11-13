import path from "path";
import { readFile, readdir, rm } from "fs/promises";
import { spawn } from "child_process";
import { getYtDlpPath } from "./binaries";
import { killProcessTree } from "./media";

const SUBTITLE_FETCH_TIMEOUT_MS = 45_000;

export class TranscriptError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "TranscriptError";
  }
}

export interface TranscriptSegment {
  text: string;
  startMs: number;
  endMs: number;
}

export interface TranscriptResult {
  segments: TranscriptSegment[];
  language: string;
  /** "manual" = a human-authored caption track; "auto" = YouTube's ASR captions. */
  source: "manual" | "auto";
  /**
   * Word-level tokens with absolute timestamps, used to build animated
   * captions directly from the transcript for a clip — skipping a redundant
   * Whisper pass on that clip's audio when this coverage is good enough.
   */
  rawTokens: Token[];
}

/**
 * Extracts a YouTube video's transcript via yt-dlp's subtitle download (no
 * video/audio download needed). Prefers manually-created captions — they're
 * more accurate and don't have the rolling-duplicate-line format ASR captions
 * do — and falls back to auto-generated captions if that's all that exists.
 * Throws TranscriptError (never fabricates timestamps) if neither is available.
 */
export async function extractYoutubeTranscript(url: string, workDir: string): Promise<TranscriptResult> {
  const tracks = await listCaptionTracks(url);

  const manualLang = pickManualTrack(tracks.manual);
  if (manualLang) {
    const manual = await downloadTrack(url, workDir, manualLang, { auto: false });
    if (manual) return parseVttFile(manual, "manual");
  }

  const autoLang = pickAutoTrack(tracks.auto);
  if (autoLang) {
    const auto = await downloadTrack(url, workDir, autoLang, { auto: true });
    if (auto) return parseVttFile(auto, "auto");
  }

  if (!manualLang && !autoLang) {
    throw new TranscriptError(
      "This video has no captions available (neither manual nor auto-generated) — transcript-based analysis isn't possible for it."
    );
  }
  throw new TranscriptError("YouTube has captions for this video but the caption download failed.");
}

interface CaptionTracks {
  manual: string[];
  auto: string[];
}

/**
 * Asks yt-dlp which caption tracks exist (one metadata request, no caption
 * downloads), so we can then fetch exactly ONE track. Requesting a pattern
 * like "en.*" downloads every matching track (en, en-US, en-US-orig, …), and
 * that burst of caption requests is what trips YouTube's HTTP 429.
 */
async function listCaptionTracks(url: string): Promise<CaptionTracks> {
  const { stdout, stderr } = await runYtDlp([url, "--skip-download", "--dump-single-json", "--no-playlist"]);
  let info: { subtitles?: Record<string, unknown>; automatic_captions?: Record<string, unknown> };
  try {
    info = JSON.parse(stdout);
  } catch (err) {
    if (isRateLimited(stderr)) throw rateLimitError();
    throw new TranscriptError(`Couldn't read this video's caption list from YouTube: ${lastLine(stderr)}`, err);
  }
  const keys = (o?: Record<string, unknown>) => Object.keys(o ?? {}).filter((k) => k !== "live_chat");
  return { manual: keys(info.subtitles), auto: keys(info.automatic_captions) };
}

/** Human-made captions: English first, then Hindi, then whatever exists. */
function pickManualTrack(langs: string[]): string | null {
  return (
    langs.find((l) => l === "en") ??
    langs.find((l) => l.startsWith("en")) ??
    langs.find((l) => l.startsWith("hi")) ??
    langs[0] ??
    null
  );
}

/**
 * YouTube's ASR captions: the "-orig" track is what was actually said; every
 * other auto track is a machine translation of it (for a Hinglish video, "en"
 * would be a translation, not the real words). Only fall back to English if
 * no original track is listed.
 */
function pickAutoTrack(langs: string[]): string | null {
  return langs.find((l) => l.endsWith("-orig")) ?? langs.find((l) => l === "en") ?? langs.find((l) => l.startsWith("en")) ?? null;
}

const RATE_LIMIT_RETRY_DELAYS_MS = [5_000, 15_000];

/** Downloads one caption track, retrying with backoff if YouTube answers 429. */
async function downloadTrack(
  url: string,
  workDir: string,
  lang: string,
  opts: { auto: boolean }
): Promise<string | null> {
  const prefix = `subs-${opts.auto ? "auto" : "manual"}`;
  const outTemplate = path.join(workDir, `${prefix}.%(ext)s`);
  const args = [
    url,
    "--skip-download",
    "--sub-lang",
    lang,
    "--sub-format",
    "vtt",
    "-o",
    outTemplate,
    "--no-playlist",
    opts.auto ? "--write-auto-sub" : "--write-subs",
  ];

  for (let attempt = 0; ; attempt++) {
    const { stderr } = await runYtDlp(args);
    const file = await findFile(workDir, prefix);
    if (file) return file;
    if (!isRateLimited(stderr)) return null;
    if (attempt >= RATE_LIMIT_RETRY_DELAYS_MS.length) throw rateLimitError();
    await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_DELAYS_MS[attempt]));
  }
}

async function findFile(workDir: string, prefix: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(workDir);
  } catch {
    return null;
  }
  const match = entries.find((f) => f.startsWith(prefix) && f.endsWith(".vtt"));
  return match ? path.join(workDir, match) : null;
}

function runYtDlp(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(getYtDlpPath(), args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr });
    };
    // yt-dlp occasionally hangs network-bound (observed in practice: near-zero
    // CPU for minutes, not a crash, not a clean exit) — most likely YouTube
    // throttling/serving a consent wall after repeated requests. Without a
    // hard timeout this would hang the whole analysis forever; with it, we
    // just treat this attempt as "didn't get a transcript" and move on.
    const timer = setTimeout(() => {
      if (proc.pid) killProcessTree(proc.pid);
      settle();
    }, SUBTITLE_FETCH_TIMEOUT_MS);
    // Exit codes don't matter here — callers check what landed on disk/stdout.
    proc.on("error", settle);
    proc.on("close", settle);
  });
}

function isRateLimited(stderr: string): boolean {
  return /HTTP Error 429|Too Many Requests/i.test(stderr);
}

function rateLimitError(): TranscriptError {
  return new TranscriptError(
    "YouTube is rate-limiting caption downloads from this server (HTTP 429: Too Many Requests). The video does have captions — try again in 30-60 minutes."
  );
}

function lastLine(text: string): string {
  return text.trim().split("\n").pop() ?? "";
}

const TIMESTAMP_RE = /(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;
const CUE_HEADER_RE = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/;

function parseTimestamp(ts: string): number {
  const m = TIMESTAMP_RE.exec(ts);
  if (!m) return 0;
  const [, h, min, s, ms] = m;
  return (Number(h) * 3600 + Number(min) * 60 + Number(s)) * 1000 + Number(ms);
}

export interface Token {
  text: string;
  atMs: number;
}

async function parseVttFile(filePath: string, source: "manual" | "auto"): Promise<TranscriptResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    throw new TranscriptError(`Failed to read downloaded transcript file "${filePath}".`, err);
  } finally {
    // Best-effort cleanup of the temp subtitle file(s); failure here doesn't matter.
    rm(path.dirname(filePath), { recursive: true, force: true }).catch(() => {});
  }

  const languageMatch = /^Language:\s*(.+)$/m.exec(raw);
  const language = languageMatch?.[1]?.trim() ?? "en";

  const blocks = raw
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .map((b) => b.trim())
    .filter(Boolean);

  let segments: TranscriptSegment[];
  let rawTokens: Token[];
  if (source === "manual") {
    const cues = parseManualCues(blocks);
    segments = cues;
    rawTokens = tokensFromManualCues(cues);
  } else {
    rawTokens = parseAutoTokens(blocks);
    segments = dedupeAutoTokensIntoSegments(rawTokens);
  }

  if (segments.length === 0) {
    throw new TranscriptError(`Transcript file "${filePath}" parsed to zero usable segments.`);
  }

  return { segments, language, source, rawTokens };
}

/**
 * Manual captions only give us segment-level [startMs, endMs] ranges, not
 * per-word timing. Spreading each segment's words evenly across its range is
 * an approximation, but it's close enough for animated caption display and
 * avoids running Whisper on a clip we already have real transcript text for.
 */
function tokensFromManualCues(cues: TranscriptSegment[]): Token[] {
  const tokens: Token[] = [];
  for (const cue of cues) {
    const words = cue.text.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const span = Math.max(1, cue.endMs - cue.startMs);
    const step = span / words.length;
    words.forEach((word, i) => {
      tokens.push({ text: word, atMs: Math.round(cue.startMs + i * step) });
    });
  }
  return tokens;
}

function parseManualCues(blocks: string[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const headerLine = lines.find((l) => CUE_HEADER_RE.test(l));
    if (!headerLine) continue;
    const header = CUE_HEADER_RE.exec(headerLine)!;
    const startMs = parseTimestamp(header[1]);
    const endMs = parseTimestamp(header[2]);
    const text = lines
      .slice(lines.indexOf(headerLine) + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) segments.push({ text, startMs, endMs });
  }
  return segments;
}

/**
 * YouTube's auto-captions render as a scrolling 1-2 line window: consecutive
 * cues repeat part or all of the previous cue's text, sometimes with zero new
 * words (a pure "freeze frame" cue holding the display steady) and sometimes
 * with new words appended. Trying to key off inline <timestamp> tags or line
 * position turned out unreliable (both pure-echo and genuinely-new cues can
 * have zero tags, one line, or two lines — there's no structural marker).
 * The robust approach: take each cue's last non-blank line as its full
 * visible caption text, then diff it word-by-word against the previous cue's
 * text via longest-overlap alignment, keeping only the words that aren't a
 * continuation of what we've already seen. This is the standard technique
 * for de-duplicating this exact YouTube ASR caption format.
 */
function parseAutoTokens(blocks: string[]): Token[] {
  const tokens: Token[] = [];
  let previousWords: string[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    const headerLine = lines.find((l) => CUE_HEADER_RE.test(l));
    if (!headerLine) continue;
    const header = CUE_HEADER_RE.exec(headerLine)!;
    const cueStartMs = parseTimestamp(header[1]);

    const textLines = lines.slice(lines.indexOf(headerLine) + 1).filter((l) => l.trim().length > 0);
    const lastLine = textLines[textLines.length - 1];
    if (!lastLine) continue;

    const currentWords = lastLine
      .replace(/<[^>]+>/g, "") // strip inline timestamp/<c> tags — not needed at this granularity
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (currentWords.length === 0) continue;

    const overlap = longestOverlap(previousWords, currentWords);
    const newWords = currentWords.slice(overlap);
    for (const word of newWords) {
      tokens.push({ text: word, atMs: cueStartMs });
    }
    previousWords = currentWords;
  }
  return tokens;
}

/** Largest k such that previousWords' last k words equal currentWords' first k words. */
function longestOverlap(previousWords: string[], currentWords: string[]): number {
  const maxK = Math.min(previousWords.length, currentWords.length);
  for (let k = maxK; k > 0; k--) {
    let matches = true;
    for (let i = 0; i < k; i++) {
      if (previousWords[previousWords.length - k + i] !== currentWords[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return k;
  }
  return 0;
}

function dedupeAutoTokensIntoSegments(tokens: Token[]): TranscriptSegment[] {
  // Deduplication already happened in parseAutoTokens via word-overlap diffing;
  // tokens here are already the unique new words in order (several words from
  // the same cue intentionally share one timestamp, so no further filtering
  // by strictly-increasing time is correct or needed here).
  return bucketTokensIntoSegments(tokens);
}

/**
 * Groups a flat, already-deduplicated token stream into readable segments —
 * shared by the YouTube-caption path and the Whisper-caption path (for
 * non-YouTube sources), so both produce the same TranscriptSegment shape for
 * the model-comparison feature regardless of where the transcript came from.
 */
export function bucketTokensIntoSegments(tokens: Token[]): TranscriptSegment[] {
  const kept = tokens;

  // Group into readable segments: break on sentence-ending punctuation or
  // after ~40 words / ~20 seconds, whichever comes first — small enough for
  // an LLM to reason about per-segment timing, large enough to avoid
  // thousands of one-word segments.
  const segments: TranscriptSegment[] = [];
  let bucket: Token[] = [];
  const flush = () => {
    if (bucket.length === 0) return;
    const text = bucket.map((t) => t.text).join(" ");
    segments.push({ text, startMs: bucket[0].atMs, endMs: bucket[bucket.length - 1].atMs });
    bucket = [];
  };

  for (const token of kept) {
    bucket.push(token);
    const bucketSpanMs = bucket[bucket.length - 1].atMs - bucket[0].atMs;
    const endsSentence = /[.!?]$/.test(token.text);
    if ((endsSentence && bucket.length >= 6) || bucket.length >= 40 || bucketSpanMs >= 20_000) {
      flush();
    }
  }
  flush();

  return segments;
}

/**
 * Converts Whisper's word-level Caption[] (from transcribing a non-YouTube
 * source's audio) into the same TranscriptSegment[] shape the YouTube path
 * produces, so the multi-model comparison feature works identically
 * regardless of where the transcript came from.
 */
export function captionsToSegments(captions: Array<{ text: string; startMs: number }>): TranscriptSegment[] {
  const tokens: Token[] = captions
    .map((c) => ({ text: c.text.trim(), atMs: c.startMs }))
    .filter((t) => t.text.length > 0);
  return bucketTokensIntoSegments(tokens);
}

/** The transcript's text for a stretch of the video, as a spelling reference for clip captions. */
export function referenceText(segments: TranscriptSegment[] | undefined, startSeconds: number, endSeconds: number): string | undefined {
  const text = (segments ?? [])
    .filter((s) => s.endMs / 1000 > startSeconds && s.startMs / 1000 < endSeconds)
    .map((s) => s.text.replace(/&gt;/g, ">").replace(/>>/g, "").trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}
