import type { FramingSegment } from "../../remotion/types";
import { parseCaptionStyle, type CaptionStyle } from "./captionStyle";
import type { KeepRange } from "./tighten";

/** How one stretch of the clip is framed when the user overrides the automatic choice. */
export interface LayoutOverride {
  fromSeconds: number;
  toSeconds: number;
  /** "fill": full-screen crop at focusX; "wide": square view over blur; "fit": whole frame. */
  mode: "fill" | "wide" | "fit";
  focusX: number;
}

/** A picture the user uploaded, shown full-screen over these source seconds (voice and captions keep going). */
export interface BrollItem {
  file: string;
  fromSeconds: number;
  toSeconds: number;
}

/** Uploaded B-roll files: the server names them, so only this shape is ever trusted. */
export const BROLL_FILE = /^broll-[0-9a-f-]{36}\.(png|jpg|webp)$/;

/**
 * A user's edits to one clip, made in the editor by hand or by asking the AI.
 * Times are source seconds, so they survive moving the clip's edges.
 * Anything left out keeps the automatic behaviour.
 */
export interface ClipEdit {
  /** Stretches cut out of the clip (removed words). */
  removed?: KeepRange[];
  /** Play the hook line first (hook-first); default on when the clip has one. */
  hook?: boolean;
  /** Shorten long pauses; default on. */
  trimPauses?: boolean;
  /** Caption corrections: the word starting at this source time (ms) reads `text`. */
  wordFixes?: Array<{ ms: number; text: string }>;
  layout?: LayoutOverride[];
  /** This clip's caption look; null = no captions; absent = the video's setting. */
  captionStyle?: CaptionStyle | null;
  broll?: BrollItem[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const range = (v: unknown): KeepRange | null => {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [s, e] = [num(v[0]), num(v[1])];
  return s !== null && e !== null && e > s && s >= 0 ? [s, e] : null;
};

/** Validates an edit from the browser (a trust boundary): unknown or malformed parts are dropped. */
export function parseClipEdit(raw: unknown): ClipEdit {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const edit: ClipEdit = {};
  if (Array.isArray(o.removed)) edit.removed = o.removed.map(range).filter((r): r is KeepRange => r !== null).slice(0, 500);
  if (typeof o.hook === "boolean") edit.hook = o.hook;
  if (typeof o.trimPauses === "boolean") edit.trimPauses = o.trimPauses;
  if (Array.isArray(o.wordFixes)) {
    edit.wordFixes = o.wordFixes
      .map((f) => (f && typeof f === "object" ? (f as Record<string, unknown>) : {}))
      .filter((f) => num(f.ms) !== null && typeof f.text === "string")
      .map((f) => ({ ms: f.ms as number, text: (f.text as string).replace(/[\r\n{}\\]/g, " ").slice(0, 60) }))
      .slice(0, 500);
  }
  if (Array.isArray(o.layout)) {
    edit.layout = o.layout
      .map((l) => (l && typeof l === "object" ? (l as Record<string, unknown>) : {}))
      .filter((l) => range([l.fromSeconds, l.toSeconds]) && (l.mode === "fill" || l.mode === "wide" || l.mode === "fit"))
      .map((l) => ({
        fromSeconds: l.fromSeconds as number,
        toSeconds: l.toSeconds as number,
        mode: l.mode as LayoutOverride["mode"],
        focusX: Math.min(100, Math.max(0, num(l.focusX) ?? 50)),
      }))
      .slice(0, 100);
  }
  if (Array.isArray(o.broll)) {
    edit.broll = o.broll
      .map((b) => (b && typeof b === "object" ? (b as Record<string, unknown>) : {}))
      .filter((b) => typeof b.file === "string" && BROLL_FILE.test(b.file) && range([b.fromSeconds, b.toSeconds]))
      .map((b) => ({ file: b.file as string, fromSeconds: b.fromSeconds as number, toSeconds: b.toSeconds as number }))
      .slice(0, 30);
  }
  if (o.captionStyle === null) edit.captionStyle = null;
  else if (o.captionStyle && typeof o.captionStyle === "object") edit.captionStyle = parseCaptionStyle(o.captionStyle);
  return edit;
}

/** `keep` minus every `removed` stretch (both in the same time base, sorted keep). */
export function subtractRanges(keep: KeepRange[], removed: KeepRange[]): KeepRange[] {
  let out = keep.map((r): KeepRange => [...r]);
  for (const [rs, re] of removed) {
    out = out.flatMap(([s, e]): KeepRange[] => {
      if (re <= s || rs >= e) return [[s, e]];
      return [
        ...(rs > s ? [[s, rs] as KeepRange] : []),
        ...(re < e ? [[re, e] as KeepRange] : []),
      ];
    });
  }
  return out.filter(([s, e]) => e - s > 0.05);
}

/** Automatic framing with the user's overrides laid on top (clip-relative seconds). */
export function applyLayout(framing: FramingSegment[], layout: LayoutOverride[], duration: number): FramingSegment[] {
  if (!layout.length) return framing;
  const base = framing.length ? framing : [{ fromSeconds: 0, toSeconds: duration, mode: "fit" as const, focusX: 50 }];
  const cuts = [...new Set([0, duration, ...base.flatMap((f) => [f.fromSeconds, f.toSeconds]), ...layout.flatMap((l) => [l.fromSeconds, l.toSeconds])])]
    .filter((t) => t >= 0 && t <= duration)
    .sort((a, b) => a - b);
  const out: FramingSegment[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [from, to] = [cuts[i], cuts[i + 1]];
    const mid = (from + to) / 2;
    const own = [...layout].reverse().find((l) => mid >= l.fromSeconds && mid < l.toSeconds);
    const auto = base.find((f) => mid >= f.fromSeconds && mid < f.toSeconds) ?? base[base.length - 1];
    const seg: FramingSegment = own ? { fromSeconds: from, toSeconds: to, mode: own.mode, focusX: own.focusX } : { ...auto, fromSeconds: from, toSeconds: to };
    const prev = out.at(-1);
    if (prev && prev.mode === seg.mode && prev.focusX === seg.focusX && prev.mode !== "split") prev.toSeconds = to;
    else out.push(seg);
  }
  return out;
}
