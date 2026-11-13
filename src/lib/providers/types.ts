import type { TranscriptSegment } from "../transcript";
import type { Provider } from "../keystore";
import type { ClipLengthRange } from "../clipLength";

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: "rate_limit" | "invalid_key" | "other",
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** The normalized shape every provider/model must return, regardless of its native API. */
export interface NormalizedClip {
  startSeconds: number;
  endSeconds: number;
  title: string;
  hook: string;
  description: string;
  reasoning: string;
  viralScore: number;
  category: string;
  engagementPotential: string;
}

export interface AnalyzeResult {
  clips: NormalizedClip[];
  rawResponse: unknown;
  tokenUsage: { inputTokens?: number; outputTokens?: number } | null;
  durationMs: number;
}

export interface ModelDescriptor {
  id: string;
  label: string;
  /** Usable on the provider's free API tier (rate-limited). */
  free?: boolean;
}

export interface ModelProvider {
  id: Provider;
  label: string;
  models: ModelDescriptor[];
  analyze(args: {
    apiKey: string;
    model: string;
    segments: TranscriptSegment[];
    targetCount: number;
    range: ClipLengthRange;
  }): Promise<AnalyzeResult>;
}

export const ANALYSIS_PROMPT_VERSION = "v4";

function formatTranscript(segments: TranscriptSegment[]): string {
  return segments.map((s) => `[${(s.startMs / 1000).toFixed(1)}s - ${(s.endMs / 1000).toFixed(1)}s] ${s.text}`).join("\n");
}

function clipRules(range: ClipLengthRange): string {
  return `- Works as a STANDALONE clip — no earlier context needed to understand or care about it. If it would open on a pronoun, a "so"/"that", or an answer whose question came earlier, move the START back to where the idea begins; never fix it by cutting the ending short.
- Has a strong hook in its opening line (bold claim, question, emotional beat, surprising fact). The 2-second test: would the first 2 seconds stop a viewer with no context from scrolling?
- Is a complete thought/story/exchange, not a mid-idea cutoff.
- Is between ${range.minSeconds} and ${range.maxSeconds} seconds long. This length range is a hard requirement set by the user.
- For interviews/podcasts: start the clip on the interviewer's question or setup line, not mid-answer, so the viewer sees both people and gets the context.
- End the clip only once the speaker has FINISHED their point: the last line must land the payoff/conclusion, not stop mid-explanation or mid-story. Right after that line, stop — NEVER include the start of the next question, a new topic, or a transition line. If the moment is shorter than the range, add setup context BEFORE it, never extra lines after it.
- Has genuine substance — not filler or someone trailing off.
- Never includes channel promotion: asking viewers to like, share, subscribe, follow or comment, or a sponsor/ad read.`;
}

function clipFields(): string {
  return `- start_time: absolute seconds in the video (matching the transcript's own timestamps)
- end_time: absolute seconds in the video
- title: short punchy working title, 10 words max
- hook: the specific opening line or moment that grabs attention
- description: what happens in this clip, 1-2 sentences
- reasoning: why this moment has short-form viral potential
- viral_score: 0-100
- category: a short content category label (e.g. "personal story", "hot take", "advice", "humor", "debate")
- engagement_potential: a short phrase on why viewers would engage (comment/share/rewatch)

Return ONLY valid JSON matching this exact shape:
{"clips": [{"start_time": number, "end_time": number, "title": string, "hook": string, "description": string, "reasoning": string, "viral_score": number, "category": string, "engagement_potential": string}, ...]}`;
}

/** Same instructions for every provider/model — required for a fair comparison. */
export function buildAnalysisPrompt(segments: TranscriptSegment[], targetCount: number, range: ClipLengthRange): string {
  return `You are an expert short-form video editor who finds viral clip-worthy moments inside long-form video/podcast/interview content, working from a TIMESTAMPED TRANSCRIPT (you cannot see the video itself).

Below is the full transcript, as timestamped segments (seconds from the start of the video):

${formatTranscript(segments)}

Find exactly ${targetCount} candidate clips for short-form content (Reels/Shorts/TikTok). A good candidate:
${clipRules(range)}

Pick clips spread across the video rather than clustering in one stretch, and make sure none of them overlap in time.

For each of the ${targetCount} clips, return ALL of these fields:
${clipFields()}`;
}

/** Pass 1 of windowed picking: how strong is the best moment in each window? */
export function buildWindowScorePrompt(windows: Array<{ id: string; segments: TranscriptSegment[] }>): string {
  const blocks = windows.map((w) => `=== WINDOW ${w.id} ===\n${formatTranscript(w.segments)}`).join("\n\n");
  return `You are a senior short-form video strategist. Below are excerpts ("windows") of a long podcast/interview transcript, with timestamps in seconds.

${blocks}

Score EVERY window from 0 to 100 for how strong a viral short-form clip (Reels/Shorts) could be cut from it.
- The 2-second test is the main criterion: would the opening of the best moment in it make a viewer with no context keep watching? Moments that only work with earlier context score low.
- Score high for strong hooks, conflict, surprise, emotion, a big number, a clear payoff, a complete story.
- Score low for filler, intros/outros, housekeeping, rambling transitions, and channel promotion (like/share/subscribe, ads).

Return ONLY JSON: {"windows": [{"id": string, "score": number}, ...]} with one entry per window.`;
}

export function parseWindowScores(jsonText: string): Map<string, number> {
  const stripped = jsonText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const items = (JSON.parse(stripped) as { windows?: unknown })?.windows;
  const scores = new Map<string, number>();
  if (!Array.isArray(items)) return scores;
  for (const item of items) {
    const { id, score } = (item ?? {}) as { id?: unknown; score?: unknown };
    if (typeof id === "string" && Number.isFinite(Number(score))) scores.set(id, Number(score));
  }
  return scores;
}

/** Pass 2 of windowed picking: the clips inside one shortlisted window. */
export function buildWindowClipPrompt(segments: TranscriptSegment[], range: ClipLengthRange): string {
  const from = (segments[0]?.startMs ?? 0) / 1000;
  const to = (segments[segments.length - 1]?.endMs ?? 0) / 1000;
  return `You are an expert short-form video editor who finds viral clip-worthy moments inside long-form video/podcast/interview content, working from a TIMESTAMPED TRANSCRIPT (you cannot see the video itself).

Below is one excerpt of a longer video, ${from.toFixed(1)}s to ${to.toFixed(1)}s, as timestamped segments (seconds from the start of the video). It was already shortlisted as one of the strongest parts of the video:

${formatTranscript(segments)}

Find 1 or 2 clips for short-form content (Reels/Shorts/TikTok) inside this excerpt. Return 2 only if they are genuinely different moments that do not overlap; return none only if nothing here is worth publishing. Every clip must start and end inside ${from.toFixed(1)}s-${to.toFixed(1)}s. A good clip:
${clipRules(range)}

For each clip, return ALL of these fields:
${clipFields()}`;
}

export function parseNormalizedClips(jsonText: string): NormalizedClip[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // Some models wrap JSON in markdown code fences despite instructions; try stripping those.
    const stripped = jsonText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    parsed = JSON.parse(stripped);
  }

  const clipsRaw = (parsed as { clips?: unknown[] })?.clips;
  if (!Array.isArray(clipsRaw)) throw new Error("Response did not contain a 'clips' array.");

  const out: NormalizedClip[] = [];
  for (const c of clipsRaw) {
    const o = c as Record<string, unknown>;
    if (
      typeof o?.start_time === "number" &&
      typeof o?.end_time === "number" &&
      typeof o?.title === "string"
    ) {
      out.push({
        startSeconds: o.start_time,
        endSeconds: o.end_time,
        title: o.title,
        hook: typeof o.hook === "string" ? o.hook : "",
        description: typeof o.description === "string" ? o.description : "",
        reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
        viralScore: typeof o.viral_score === "number" ? o.viral_score : 0,
        category: typeof o.category === "string" ? o.category : "uncategorized",
        engagementPotential: typeof o.engagement_potential === "string" ? o.engagement_potential : "",
      });
    }
  }
  return out;
}

/** Picks clips window by window instead of from the whole transcript at once. */
export type WindowedPicker = (args: {
  segments: TranscriptSegment[];
  targetCount: number;
  range: ClipLengthRange;
}) => Promise<AnalyzeResult>;

/** A clip's closing sentences and the ones that follow it in the video. */
export interface EndCheckInput {
  inside: Array<{ text: string }>;
  following: Array<{ text: string; turn: boolean }>;
}

/**
 * The line the clip should end after: 0 = its current last line, negative =
 * an earlier line inside the clip (the point finished sooner), positive = one
 * of the following lines (the point needs them).
 */
export type EndChecker = (input: EndCheckInput) => Promise<number>;

export function buildEndCheckPrompt(inside: EndCheckInput["inside"], following: EndCheckInput["following"]): string {
  const close = inside.map((s, i) => `  [${i - inside.length + 1}] ${s.text}`).join("\n");
  const next = following.map((s, i) => `  [${i + 1}]${s.turn ? " (other speaker)" : ""} ${s.text}`).join("\n");
  return `You are editing a short vertical clip cut from a podcast. The last lines of the clip, ending with line [0]:
${close}

In the full video, these lines come right after the cut:
${next}

After which line has the speaker finished their point?
- [0] if the clip already ends right where the point lands.
- An earlier line ([-1], [-2], ...) if the point was already finished there and the lines after it drift into something else: a new topic, a side story, a promo (like/share/subscribe), small talk.
- A later line ([1], [2], ...) if those lines complete the same thought (the conclusion, the punchline, the rest of the story). Never a new question or a new topic.

Return ONLY JSON: {"end_after": number}`;
}

export function parseEndCheck(jsonText: string, before: number, after: number): number {
  const stripped = jsonText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const n = Number((JSON.parse(stripped) as { end_after?: unknown })?.end_after);
  return Number.isFinite(n) ? Math.max(-(before - 1), Math.min(after, Math.round(n))) : 0;
}
