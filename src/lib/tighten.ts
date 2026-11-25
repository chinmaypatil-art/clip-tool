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

/** Captions on the tightened timeline; words that were cut out, and fillers ("uh"), are dropped. */
export function remapCaptions(words: Caption[], ranges: KeepRange[]): Caption[] {
  return words
    .filter((w) => !isFiller(w.text))
    .filter((w) => {
      const mid = (w.startMs + w.endMs) / 2000;
      return ranges.some(([s, e]) => mid >= s && mid <= e);
    })
    .map((w) => {
      const startMs = Math.round(mapTime(ranges, w.startMs / 1000) * 1000);
      const endMs = Math.max(startMs, Math.round(mapTime(ranges, w.endMs / 1000) * 1000));
      return { ...w, startMs, endMs, timestampMs: w.timestampMs === null ? null : Math.round(mapTime(ranges, w.timestampMs / 1000) * 1000) };
    });
}

export function remapFraming(framing: FramingSegment[], ranges: KeepRange[]): FramingSegment[] {
  return framing
    .map((f) => ({ ...f, fromSeconds: mapTime(ranges, f.fromSeconds), toSeconds: mapTime(ranges, f.toSeconds) }))
    .filter((f, i) => i === 0 || f.toSeconds > f.fromSeconds);
}
