import type { TranscriptSegment } from "./transcript";

// A beat after the last word so the clip doesn't end mid-breath.
const END_PAD_SECONDS = 0.4;

/**
 * Models stretch clips to hit the length range by tacking on the next line,
 * which is usually the interviewer opening a new topic ("So tell me…?").
 * If the clip's final line is a question that begins after the clip's first
 * line, cut the clip back to just after the line before it.
 */
export function trimTrailingQuestion(
  startSeconds: number,
  endSeconds: number,
  segments: TranscriptSegment[] | undefined
): number {
  if (!segments?.length) return endSeconds;
  const inside = segments.filter((s) => s.startMs / 1000 >= startSeconds - 0.5 && s.startMs / 1000 < endSeconds - 0.5);
  if (inside.length < 2) return endSeconds;
  const last = inside[inside.length - 1];
  if (!last.text.trim().endsWith("?")) return endSeconds;
  const payoff = inside[inside.length - 2];
  return Math.min(endSeconds, payoff.endMs / 1000 + END_PAD_SECONDS);
}
