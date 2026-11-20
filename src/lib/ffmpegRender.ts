import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, rm } from "fs/promises";
import type { TikTokPage } from "@remotion/captions";
import type { FramingSegment } from "../../remotion/types";
import { WIDTH, HEIGHT, FPS } from "../../remotion/types";
import { getFfmpegPath } from "./binaries";
import { probeVideo } from "./media";
import { CAPTION_FONTS, CAPTION_SIZES, DEFAULT_CAPTION_STYLE, type CaptionStyle } from "./captionStyle";

const runFile = promisify(execFile);
// Every external tool gets a time limit, so a stuck process fails the job
// instead of holding it (and the render queue) forever.
const execFileAsync = ((file: string, args: readonly string[], opts: object = {}) =>
  runFile(file, args, { timeout: 30 * 60_000, windowsHide: true, ...opts })) as unknown as typeof runFile;

/**
 * Renders a clip with ffmpeg alone (approach from openshorts, MIT): the
 * framing becomes crop/scale filters, captions become a karaoke ASS file
 * burned in by libass, and the GPU encoder (NVENC) does the encode. Matches
 * the Remotion template (remotion/templates/ClipClassic.tsx) closely at a
 * fraction of the time: no browser, no per-frame screenshots.
 */

const HALF_HEIGHT = HEIGHT / 2;
const SPLIT_FACE_SHARE = 0.3;
const BACKGROUND = "0x0a0a0f";
const FADE_IN_SECONDS = 0.15;
const FADE_OUT_SECONDS = 0.3;

export interface FfmpegRenderInput {
  /** A cut of the source that starts exactly at the clip start. */
  segmentPath: string;
  outputPath: string;
  durationSeconds: number;
  captionPages: TikTokPage[];
  /** null burns in no captions; undefined uses the default style. */
  captionStyle?: CaptionStyle | null;
  framing: FramingSegment[];
}

let nvencOk: Promise<boolean> | null = null;

/** One tiny encode proves h264_nvenc works here; cached for the server's life. */
function nvencAvailable(): Promise<boolean> {
  nvencOk ??= execFileAsync(getFfmpegPath(), [
    "-hide_banner", "-f", "lavfi", "-i", "color=black:s=256x256:d=0.1", "-c:v", "h264_nvenc", "-f", "null", "-",
  ], { timeout: 30_000 }).then(() => true, () => false);
  return nvencOk;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Filter chain turning [in] into one WIDTH x HEIGHT shot. */
function shotFilter(shot: FramingSegment | undefined, srcW: number, srcH: number, input: string, out: string): string {
  return shotChain(shot, srcW, srcH, input, `${out}r`) + `;[${out}r]setsar=1[${out}]`;
}

function shotChain(shot: FramingSegment | undefined, srcW: number, srcH: number, input: string, out: string): string {
  const aspect = srcW / srcH;
  if (shot?.mode === "split" && shot.people?.length === 2) {
    const a = shot.sourceAspect ?? aspect;
    const halves = shot.people.map((p, k) => {
      // Same geometry as SplitHalf in ClipClassic.tsx.
      const minWidth = Math.max(WIDTH, HALF_HEIGHT * a);
      const vw = Math.min(Math.max((SPLIT_FACE_SHARE * WIDTH) / Math.max(p.w, 0.01), minWidth), WIDTH / 0.25);
      const vh = vw / a;
      const left = Math.min(0, Math.max(WIDTH - vw, WIDTH / 2 - p.cx * vw));
      const y = Math.min(0, Math.max(HALF_HEIGHT - vh, HALF_HEIGHT * 0.42 - p.cy * vh));
      const w = even(vw), h = even(vh);
      const x = Math.min(Math.max(0, Math.round(-left)), w - WIDTH);
      const yy = Math.min(Math.max(0, Math.round(-y)), h - HALF_HEIGHT);
      return `[${input}h${k}]scale=${w}:${h},crop=${WIDTH}:${HALF_HEIGHT}:${x}:${yy}[${input}s${k}]`;
    });
    return [
      `[${input}]split[${input}h0][${input}h1]`,
      ...halves,
      `[${input}s0][${input}s1]vstack,drawbox=x=0:y=${HALF_HEIGHT - 3}:w=${WIDTH}:h=6:color=${BACKGROUND}:t=fill[${out}]`,
    ].join(";");
  }
  if (shot?.mode === "fill") {
    // CSS object-fit: cover + object-position: focusX% 50%.
    const scale = Math.max(WIDTH / srcW, HEIGHT / srcH);
    const w = even(srcW * scale), h = even(srcH * scale);
    const x = Math.round(((w - WIDTH) * shot.focusX) / 100);
    const y = Math.round((h - HEIGHT) / 2);
    return `[${input}]scale=${w}:${h},crop=${WIDTH}:${HEIGHT}:${x}:${y}[${out}]`;
  }
  // "fit" (or no analysis): letterbox the whole frame on a dark background.
  return `[${input}]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${BACKGROUND}[${out}]`;
}

function videoGraph(framing: FramingSegment[], duration: number, srcW: number, srcH: number): string {
  const shots = framing.length ? framing : [undefined];
  if (shots.length === 1) return `[0:v]fps=${FPS},setsar=1[v0];${shotFilter(shots[0], srcW, srcH, "v0", "vout")}`;
  const parts = [`[0:v]fps=${FPS},setsar=1,split=${shots.length}${shots.map((_, i) => `[c${i}]`).join("")}`];
  shots.forEach((shot, i) => {
    const from = i === 0 ? 0 : shot!.fromSeconds;
    const to = i === shots.length - 1 ? duration : shots[i + 1]!.fromSeconds;
    parts.push(`[c${i}]trim=${from.toFixed(3)}:${to.toFixed(3)},setpts=PTS-STARTPTS[t${i}]`);
    parts.push(shotFilter(shot, srcW, srcH, `t${i}`, `o${i}`));
  });
  parts.push(`${shots.map((_, i) => `[o${i}]`).join("")}concat=n=${shots.length}:v=1:a=0[vout]`);
  return parts.join(";");
}

const assTime = (ms: number) => {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
const assText = (t: string) => t.replace(/\\/g, "＼").replace(/[{}]/g, "").replace(/\n/g, " ");

/** #RRGGBB to ASS &HAABBGGRR (alpha 00 = opaque). */
const assColor = (hex: string, alpha = "00") => `&H${alpha}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();

/** The ASS style line for a CaptionStyle, matching CaptionsOverlay.tsx. */
function assStyle(style: CaptionStyle): string {
  const font = CAPTION_FONTS[style.font];
  const size = CAPTION_SIZES[style.size];
  const bold = font.weight >= 700 && style.font !== "impact" ? -1 : 0;
  // BorderStyle 1 = outline + drop shadow; 3 = opaque box (libass fills it with OutlineColour).
  const [borderStyle, outline, shadow, outlineColor] =
    style.background === "box"
      ? [3, Math.round(size * 0.18), 0, "&H40000000"]
      : style.background === "shadow"
        ? [1, 1, Math.round(size * 0.06), "&H00000000"]
        : [1, Math.max(3, Math.round(size * 0.05)), 0, "&H00000000"];
  const [alignment, marginV] = style.position === "top" ? [8, 260] : style.position === "middle" ? [5, 0] : [2, 220];
  const color = assColor(style.color);
  return `Style: Caption,${font.family},${size},${color},${color},${outlineColor},&H80000000,${bold},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},48,48,${marginV},1`;
}

/**
 * Karaoke captions matching CaptionsOverlay.tsx: the page's words in the
 * chosen font and colour, the spoken word in the highlight colour and slightly
 * larger. One event per state of the page so the highlight follows the audio.
 */
export function buildAss(pages: TikTokPage[], style: CaptionStyle = DEFAULT_CAPTION_STYLE): string {
  const base = assColor(style.color);
  const mark = style.highlight ? assColor(style.highlight) : null;
  const events: string[] = [];
  for (const page of pages) {
    const pageEnd = page.startMs + page.durationMs;
    const words = page.tokens
      .map((t) => assText(style.uppercase ? t.text.trim().toUpperCase() : t.text.trim()))
      .filter(Boolean);
    const tokens = page.tokens.filter((t) => t.text.trim());
    // Boundaries where the highlighted word changes.
    const cuts = [...new Set([page.startMs, pageEnd, ...tokens.flatMap((t) => [t.fromMs, t.toMs])])]
      .filter((ms) => ms >= page.startMs && ms <= pageEnd)
      .sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const from = cuts[i], to = cuts[i + 1];
      if (to - from < 10) continue;
      const active = tokens.findIndex((t) => from >= t.fromMs && from < t.toMs);
      const text = words
        .map((w, k) => (mark && k === active ? `{\\c${mark}&\\fscx108\\fscy108}${w}{\\c${base}&\\fscx100\\fscy100}` : w))
        .join(" ");
      events.push(`Dialogue: 0,${assTime(from)},${assTime(to)},Caption,,0,0,0,,${text}`);
    }
  }
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${WIDTH}`,
    `PlayResY: ${HEIGHT}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    assStyle(style),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

/** Escapes a Windows path for use inside an ffmpeg filter argument. */
const filterPath = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

export async function renderClipFfmpeg(input: FfmpegRenderInput): Promise<void> {
  const { width, height } = await probeVideo(input.segmentPath);
  const assPath = `${input.outputPath}.ass`;
  const graphPath = `${input.outputPath}.filter`;
  const d = input.durationSeconds;
  const captions = input.captionStyle !== null && input.captionPages.length > 0;
  const graph = [
    videoGraph(input.framing, d, width, height).replace("[vout]", "[vf]"),
    `[vf]${captions ? `ass='${filterPath(assPath)}',` : ""}format=yuv420p[vout]`,
    `[0:a]afade=t=in:d=${FADE_IN_SECONDS},afade=t=out:st=${Math.max(0, d - FADE_OUT_SECONDS).toFixed(3)}:d=${FADE_OUT_SECONDS}[aout]`,
  ].join(";\n");
  if (captions) await writeFile(assPath, buildAss(input.captionPages, input.captionStyle ?? DEFAULT_CAPTION_STYLE));
  await writeFile(graphPath, graph);
  const encoder = (await nvencAvailable())
    ? ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "21", "-b:v", "0"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"];
  try {
    await execFileAsync(
      getFfmpegPath(),
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", input.segmentPath,
        "-/filter_complex", graphPath,
        "-map", "[vout]", "-map", "[aout]",
        "-t", d.toFixed(3),
        ...encoder,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        input.outputPath,
      ],
      { maxBuffer: 16 * 1024 * 1024 }
    );
  } finally {
    await rm(assPath, { force: true }).catch(() => {});
    await rm(graphPath, { force: true }).catch(() => {});
  }
}
