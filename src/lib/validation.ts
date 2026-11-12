import type { RankedClip } from "./gemini";
import type { ClipLengthRange } from "./clipLength";
import type { TranscriptSegment } from "./transcript";
import { trimTrailingQuestion } from "./clipTrim";

export interface ValidatedClip {
  startSeconds: number;
  endSeconds: number;
  title: string;
  reason: string;
  score: number;
}

// Gemini doesn't hit the requested range exactly; picks down to this fraction
// of the minimum are still kept (dropping them could leave the job with no clips).
const SHORT_TOLERANCE = 0.6;

/**
 * Validates Gemini's final picks against reality: clamps to actual video
 * duration, drops anything with bad/inverted/out-of-range timestamps,
 * enforces the user-chosen clip length (trims long picks, drops far-too-short ones), and removes overlaps (keeping the higher score).
 */
export function validateClips(
  picks: RankedClip[],
  videoDurationSeconds: number,
  range: ClipLengthRange,
  segments?: TranscriptSegment[]
): ValidatedClip[] {
  const cleaned: ValidatedClip[] = [];

  for (const pick of picks) {
    if (
      !Number.isFinite(pick.startSeconds) ||
      !Number.isFinite(pick.endSeconds) ||
      !Number.isFinite(pick.score)
    ) {
      continue;
    }

    const start = Math.max(0, Math.min(pick.startSeconds, videoDurationSeconds));
    const end = trimTrailingQuestion(start, Math.max(0, Math.min(pick.endSeconds, videoDurationSeconds)), segments);
    if (end <= start) continue;

    const length = end - start;
    if (length < range.minSeconds * SHORT_TOLERANCE) continue;

    const clampedEnd = length > range.maxSeconds ? start + range.maxSeconds : end;

    if (!pick.title?.trim() || !pick.reason?.trim()) continue;

    cleaned.push({
      startSeconds: start,
      endSeconds: clampedEnd,
      title: pick.title.trim(),
      reason: pick.reason.trim(),
      score: Math.max(0, Math.min(100, pick.score)),
    });
  }

  // Remove overlaps: sort by score desc, greedily keep non-overlapping picks.
  cleaned.sort((a, b) => b.score - a.score);
  const kept: ValidatedClip[] = [];
  for (const candidate of cleaned) {
    const overlaps = kept.some(
      (k) => candidate.startSeconds < k.endSeconds && candidate.endSeconds > k.startSeconds
    );
    if (!overlaps) kept.push(candidate);
  }

  // Present final list in chronological order.
  kept.sort((a, b) => a.startSeconds - b.startSeconds);
  return kept;
}
