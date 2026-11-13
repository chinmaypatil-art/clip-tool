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

/**
 * Brings a too-long clip under `maxSeconds` by ending it after the last
 * transcript line that finishes in time, instead of cutting mid-sentence.
 * Falls back to a hard cut when no line ends in a usable place.
 */
export function fitToMaxLength(
  startSeconds: number,
  endSeconds: number,
  maxSeconds: number,
  minSeconds: number,
  segments: TranscriptSegment[] | undefined
): number {
  if (endSeconds - startSeconds <= maxSeconds) return endSeconds;
  const limit = startSeconds + maxSeconds;
  const lineEnds = (segments ?? [])
    .map((s) => s.endMs / 1000)
    .filter((t) => t > startSeconds + minSeconds && t <= limit);
  return lineEnds.length ? Math.max(...lineEnds) : limit;
}

export interface Sentence {
  start: number;
  end: number;
  text: string;
  /** Starts a new speaker turn (YouTube marks these with ">>"). */
  turn: boolean;
}

// How far an edge may move to reach a sentence boundary before we give up and
// move the other way instead (keeps a 45 s pick from growing to 70 s).
const MAX_EDGE_SHIFT_SECONDS = 8;
// Openers that only make sense after the previous sentence.
const DEPENDENT_OPENER = /^(and|so|but|because|or|which|that|then|also|like)\b/i;
// A reply this short from the other speaker is usually the reaction/payoff.
const MAX_REACTION_SECONDS = 8;
// Breathing room at each edge, never taken from a neighbouring sentence.
const START_PAD_SECONDS = 0.3;
const END_PAD_SECONDS_SOFT = 0.6;

/**
 * Splits caption lines into sentences. A YouTube caption line is a screenful
 * of text, not a sentence: it often holds the tail of one sentence and the
 * start of the next. Times inside a line are interpolated by character offset.
 */
export function toSentences(segments: TranscriptSegment[]): Sentence[] {
  const sentences: Sentence[] = [];
  let open: Sentence | null = null;
  for (const seg of segments) {
    const text = seg.text.replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const startS = seg.startMs / 1000;
    const span = Math.max(0, seg.endMs / 1000 - startS);
    // Pieces end at . ? ! or right before a ">>" speaker change.
    const pieces = text.split(/(?<=[.?!…])\s+|\s*(?=>>)/).filter((p) => p.trim());
    let offset = 0;
    for (const raw of pieces) {
      const at = text.indexOf(raw, offset);
      offset = at + raw.length;
      const pStart = startS + (span * at) / text.length;
      const pEnd = startS + (span * offset) / text.length;
      const turn = raw.startsWith(">>");
      const piece = raw.replace(/^(>>\s*)+/, "").trim();
      if (!piece) continue;
      // A long pause also ends a sentence, even without punctuation.
      if (open && (turn || pStart - open.end > 1.2)) {
        sentences.push(open);
        open = null;
      }
      if (open) {
        open.end = pEnd;
        open.text += " " + piece;
      } else {
        open = { start: pStart, end: pEnd, text: piece, turn };
      }
      if (/[.?!…]$/.test(piece)) {
        sentences.push(open);
        open = null;
      }
    }
  }
  if (open) sentences.push(open);
  return sentences;
}

/**
 * Moves a clip's edges onto whole sentences so it never opens on the tail of
 * the previous thought or ends on the first words of the next one.
 * - start: back to the start of the sentence it lands in; one more sentence
 *   back if that one opens with "and/so/but…" (it depends on its setup).
 * - end: on to the end of the sentence it lands in; then also the other
 *   speaker's short reply if it fits (the reaction is often the payoff).
 * - pads both edges a little, but only into silence.
 * Never makes the clip longer than `maxSeconds`.
 */
export function snapToSentences(
  startSeconds: number,
  endSeconds: number,
  maxSeconds: number,
  segments: TranscriptSegment[] | undefined
): { startSeconds: number; endSeconds: number } {
  const sentences = segments?.length ? toSentences(segments) : [];
  if (!sentences.length) return { startSeconds, endSeconds };

  // --- start
  let si = sentences.findIndex((s) => s.end > startSeconds + 0.3);
  if (si < 0) return { startSeconds, endSeconds };
  if (sentences[si].start < startSeconds - MAX_EDGE_SHIFT_SECONDS && si + 1 < sentences.length) si++;
  // In a cased transcript a lowercase opener is a speaker resuming mid-thought
  // after an interjection (">> of your separation…"), even across a turn.
  const cased = sentences.some((s) => /^[A-Z]/.test(s.text));
  const midThought = (s: Sentence) => (cased && /^[a-z]/.test(s.text)) || (DEPENDENT_OPENER.test(s.text) && !s.turn);
  while (
    si > 0 &&
    midThought(sentences[si]) &&
    startSeconds - sentences[si - 1].start <= MAX_EDGE_SHIFT_SECONDS + 2
  ) {
    si--;
  }
  const start = sentences[si].start;

  // --- end
  let ei = -1;
  for (let i = si; i < sentences.length; i++) {
    if (sentences[i].start >= endSeconds - 0.3) break;
    ei = i;
  }
  if (ei < si) ei = si;
  const fits = (i: number) => sentences[i].end - start <= maxSeconds;
  if (sentences[ei].end > endSeconds + MAX_EDGE_SHIFT_SECONDS || !fits(ei)) {
    // Finishing the sentence would run too long: end after the previous one.
    while (ei > si && !fits(ei)) ei--;
    if (ei > si && sentences[ei].end > endSeconds + MAX_EDGE_SHIFT_SECONDS) ei--;
  }
  const next = sentences[ei + 1];
  // A question or a "But…" opens a new point rather than reacting to this one.
  const isReaction =
    next?.turn &&
    next.end - next.start <= MAX_REACTION_SECONDS &&
    !next.text.endsWith("?") &&
    !DEPENDENT_OPENER.test(next.text);
  if (isReaction && fits(ei + 1)) ei++;
  if (!fits(ei)) return { startSeconds, endSeconds };
  const end = sentences[ei].end;

  const prevEnd = si > 0 ? sentences[si - 1].end : 0;
  const nextStart = sentences[ei + 1]?.start ?? Infinity;
  return {
    startSeconds: Math.max(0, prevEnd, start - START_PAD_SECONDS),
    endSeconds: Math.min(nextStart, end + END_PAD_SECONDS_SOFT, start + maxSeconds),
  };
}

/** The clip's last few sentences and the ones right after it, for an end check. */
export function endContext(
  startSeconds: number,
  endSeconds: number,
  segments: TranscriptSegment[] | undefined,
  before = 3,
  after = 5
): { inside: Sentence[]; following: Sentence[] } {
  const sentences = segments?.length ? toSentences(segments) : [];
  const inside = sentences.filter((s) => s.start >= startSeconds - 0.5 && s.start < endSeconds - 0.3);
  const following = sentences.filter((s) => s.start >= endSeconds - 0.3).slice(0, after);
  return { inside: inside.slice(-before), following };
}

export interface Silence {
  start: number;
  end: number;
}

// YouTube caption times run 1-2s ahead of the audio, so the real pause for an
// edge is usually just after it.
const START_SEARCH_AHEAD = 2.5;
const END_SEARCH_AHEAD = 3;
const END_SEARCH_BACK = 1;

/**
 * Moves each edge into the nearest following pause in the audio, so a clip
 * never starts on the previous sentence's last word or ends before the
 * speaker's last word. Edges with no pause nearby stay where they are.
 */
export function snapToSilence(
  startSeconds: number,
  endSeconds: number,
  { minSeconds, maxSeconds }: { minSeconds: number; maxSeconds: number },
  silences: Silence[]
): { startSeconds: number; endSeconds: number } {
  // The pause must begin near the edge: a pause after the first spoken word
  // would otherwise drop that word.
  const startGap = silences.find(
    (s) => s.end > startSeconds - 0.3 && s.start <= startSeconds + 1.2 && s.end <= startSeconds + START_SEARCH_AHEAD
  );
  const start = startGap ? Math.max(startGap.start, startGap.end - Math.min(0.3, (startGap.end - startGap.start) / 2)) : startSeconds;
  const endGap = silences.find(
    (s) => s.end > endSeconds + 0.05 && s.start >= endSeconds - END_SEARCH_BACK && s.start <= endSeconds + END_SEARCH_AHEAD
  );
  const end = endGap ? endGap.start + Math.min(0.5, (endGap.end - endGap.start) / 2) : endSeconds;
  if (end - start > maxSeconds || end - start < minSeconds) return { startSeconds, endSeconds };
  return { startSeconds: start, endSeconds: end };
}

// Headroom so later edge snapping can't pull a clip back under the minimum.
const MIN_LENGTH_MARGIN_SECONDS = 1;

/**
 * Grows a clip that is shorter than the minimum by moving its start back into
 * the setup (never past the payoff); at the very start of the video, the end
 * moves on instead.
 */
export function reachMinLength(
  startSeconds: number,
  endSeconds: number,
  minSeconds: number,
  durationSeconds: number
): { startSeconds: number; endSeconds: number } {
  const target = minSeconds + MIN_LENGTH_MARGIN_SECONDS;
  if (endSeconds - startSeconds >= minSeconds) return { startSeconds, endSeconds };
  const start = Math.max(0, endSeconds - target);
  return { startSeconds: start, endSeconds: Math.min(durationSeconds, Math.max(endSeconds, start + target)) };
}
