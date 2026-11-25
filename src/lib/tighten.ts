import type { Caption } from "@remotion/captions";
import type { FramingSegment } from "../../remotion/types";

/** A kept stretch of the clip, in seconds from the clip's start. */
export type KeepRange = [number, number];

// Pauses longer than this are shortened to 2 x PAD (about Descript's 200 ms).
// At 0.5 s a 2-minute clip got 30 jump cuts; 0.8 s gave about one every 11 s.
const MAX_GAP = 0.8;
// Breathing room left around every kept word so cuts never clip a syllable.
const PAD = 0.1;
// Not worth a re-cut (and its tiny risk of a bumpy edit) for less than this.
const MIN_SAVED = 1;
const FILLER = /^(u+m+|u+h+|u+h+m+|e+r+m+|h+m+|m+h*m+|a+h+)[,.!?…]*$/i;

export const isFiller = (text: string) => FILLER.test(text.trim());

/**
 * Which parts of a clip to keep: drops filler words ("um", "uh") and shortens
 * long pauses. A filler only goes when the gap it leaves is itself a long
 * pause, so quick "uh"s inside a sentence stay rather than making a jumpy cut.
 */
export function keepRanges(words: Caption[], durationSeconds: number): KeepRange[] {
  const whole: KeepRange[] = [[0, durationSeconds]];
  const spans = words
    .filter((w) => !isFiller(w.text) && w.endMs > w.startMs)
    .map((w) => [w.startMs / 1000, w.endMs / 1000] as KeepRange)
    .sort((a, b) => a[0] - b[0]);
  if (!spans.length) return whole;

  const merged: KeepRange[] = [];
  for (const [s, e] of spans) {
    const last = merged.at(-1);
    if (last && s - last[1] <= MAX_GAP) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const ranges = merged.map(([s, e], i): KeepRange => [
    i === 0 ? 0 : Math.max(0, s - PAD),
    i === merged.length - 1 ? durationSeconds : Math.min(durationSeconds, e + PAD),
  ]);
  const kept = ranges.reduce((n, [s, e]) => n + e - s, 0);
  return durationSeconds - kept < MIN_SAVED ? whole : ranges;
}

/**
 * A hook line's range stretched to whole sentences: caption lines (YouTube's
 * especially) break mid-sentence, and a teaser ending on "in a world where"
 * then jumping to the clip's start sounds broken. Extends up to 5 s to the
 * first word ending in . ? or !
 */
export function hookToSentence(words: Caption[], [from, to]: KeepRange, durationSeconds: number): KeepRange {
  const end = words.find((w) => w.endMs / 1000 >= to - 0.2 && /[.?!]["'”]?$/.test(w.text.trim()));
  const stretched = end && end.endMs / 1000 <= to + 5 ? end.endMs / 1000 + 0.15 : to;
  return [from, Math.min(durationSeconds, stretched)];
}

export const keptLength = (ranges: KeepRange[]) => ranges.reduce((n, [s, e]) => n + e - s, 0);

/** Clip time -> time in the tightened clip; a time inside a cut lands on the next kept piece. */
export function mapTime(ranges: KeepRange[], t: number): number {
  let out = 0;
  for (const [s, e] of ranges) {
    if (t <= s) return out;
    if (t <= e) return out + t - s;
    out += e - s;
  }
  return out;
}

/**
 * The output timeline piece by piece: each kept range with where it starts in
 * the output. Ranges may repeat or go back in time (a hook-first teaser plays
 * a line from later in the clip first), so every mapping goes through this.
 */
function pieces(ranges: KeepRange[]) {
  let at = 0;
  return ranges.map(([s, e]) => {
    const p = { s, e, at };
    at += e - s;
    return p;
  });
}

/** Captions on the edited timeline; words that were cut out, and fillers ("uh"), are dropped. */
export function remapCaptions(words: Caption[], ranges: KeepRange[]): Caption[] {
  const ms = (t: number, p: { s: number; at: number }) => Math.round((p.at + t - p.s) * 1000);
  return pieces(ranges).flatMap((p) =>
    words
      .filter((w) => !isFiller(w.text))
      .filter((w) => {
        const mid = (w.startMs + w.endMs) / 2000;
        return mid >= p.s && mid <= p.e;
      })
      .map((w) => {
        const startMs = ms(Math.max(p.s, w.startMs / 1000), p);
        const endMs = Math.max(startMs, ms(Math.min(p.e, w.endMs / 1000), p));
        return { ...w, startMs, endMs, timestampMs: w.timestampMs === null ? null : ms(Math.min(p.e, Math.max(p.s, w.timestampMs / 1000)), p) };
      })
  );
}

/** Framing on the edited timeline: each shot clipped to each kept piece. */
export function remapFraming(framing: FramingSegment[], ranges: KeepRange[]): FramingSegment[] {
  const out: FramingSegment[] = [];
  for (const p of pieces(ranges)) {
    for (const f of framing) {
      const from = Math.max(f.fromSeconds, p.s);
      const to = Math.min(f.toSeconds, p.e);
      if (to <= from) continue;
      const seg = { ...f, fromSeconds: p.at + from - p.s, toSeconds: p.at + to - p.s };
      const prev = out.at(-1);
      if (prev && prev.mode === seg.mode && prev.focusX === seg.focusX && Math.abs(prev.toSeconds - seg.fromSeconds) < 1e-6 && seg.mode !== "split") prev.toSeconds = seg.toSeconds;
      else out.push(seg);
    }
  }
  return out;
}
