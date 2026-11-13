import type { TranscriptSegment } from "./transcript";

/** A stretch of the transcript that a model reads on its own. */
export interface TranscriptWindow {
  id: string;
  startSeconds: number;
  endSeconds: number;
  segments: TranscriptSegment[];
}

/** Window length for picking: it must hold a max-length clip with room to place it. */
export function pickWindowSeconds(range: { maxSeconds: number }): number {
  return Math.max(90, range.maxSeconds * 1.5);
}

/**
 * Splits a transcript into overlapping windows on line boundaries, so a model
 * reads a few minutes at a time. Asked for picks over a whole long transcript
 * at once, a local model clustered every clip in the first minutes and
 * ignored the length range. Each window grows to about `windowSeconds` (up to
 * 1.25x to close on a line) and the next one starts `overlapSeconds` before it
 * ends, so a moment on a boundary is whole in one of them.
 */
export function buildTranscriptWindows(
  segments: TranscriptSegment[],
  windowSeconds: number,
  overlapSeconds = 30
): TranscriptWindow[] {
  const lines = segments.filter((s) => s.text.trim());
  const windows: TranscriptWindow[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = lines[i].startMs / 1000;
    let j = i;
    while (j + 1 < lines.length && lines[j + 1].endMs / 1000 - start <= windowSeconds * 1.25) {
      j++;
      if (lines[j].endMs / 1000 - start >= windowSeconds) break;
    }
    const end = lines[j].endMs / 1000;
    windows.push({ id: `w${windows.length + 1}`, startSeconds: start, endSeconds: end, segments: lines.slice(i, j + 1) });
    if (j >= lines.length - 1) break;
    let k = i + 1;
    while (k <= j && lines[k].startMs / 1000 < end - overlapSeconds) k++;
    i = Math.max(k, i + 1);
  }
  return windows;
}
