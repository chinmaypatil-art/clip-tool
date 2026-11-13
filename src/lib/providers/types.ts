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

export const ANALYSIS_PROMPT_VERSION = "v2";

/** Same instructions for every provider/model — required for a fair comparison. */
export function buildAnalysisPrompt(segments: TranscriptSegment[], targetCount: number, range: ClipLengthRange): string {
  const transcriptText = segments
    .map((s) => `[${(s.startMs / 1000).toFixed(1)}s - ${(s.endMs / 1000).toFixed(1)}s] ${s.text}`)
    .join("\n");

  return `You are an expert short-form video editor who finds viral clip-worthy moments inside long-form video/podcast/interview content, working from a TIMESTAMPED TRANSCRIPT (you cannot see the video itself).

Below is the full transcript, as timestamped segments (seconds from the start of the video):

${transcriptText}

Find exactly ${targetCount} candidate clips for short-form content (Reels/Shorts/TikTok). A good candidate:
- Works as a STANDALONE clip — no earlier context needed to understand or care about it.
- Has a strong hook in its opening line (bold claim, question, emotional beat, surprising fact).
- Is a complete thought/story/exchange, not a mid-idea cutoff.
- Is between ${range.minSeconds} and ${range.maxSeconds} seconds long. This length range is a hard requirement set by the user.
- For interviews/podcasts: start the clip on the interviewer's question or setup line, not mid-answer, so the viewer sees both people and gets the context.
- End the clip only once the speaker has FINISHED their point: the last line must land the payoff/conclusion, not stop mid-explanation or mid-story. Right after that line, stop — NEVER include the start of the next question, a new topic, or a transition line. If the moment is shorter than the range, add setup context BEFORE it, never extra lines after it.
- Has genuine substance — not filler or someone trailing off.

Pick clips spread across the video rather than clustering in one stretch, and make sure none of them overlap in time.

For each of the ${targetCount} clips, return ALL of these fields:
- start_time: absolute seconds in the video (matching the transcript's own timestamps)
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

/** A clip's closing sentences and the ones that follow it in the video. */
export interface EndCheckInput {
  inside: Array<{ text: string }>;
  following: Array<{ text: string; turn: boolean }>;
}

/** How many of the following sentences the clip should keep (0 = it ends right). */
export type EndChecker = (input: EndCheckInput) => Promise<number>;

export function buildEndCheckPrompt(inside: EndCheckInput["inside"], following: EndCheckInput["following"]): string {
  const close = inside.map((s) => `  ${s.text}`).join("\n");
  const next = following.map((s, i) => `  [${i + 1}]${s.turn ? " (other speaker)" : ""} ${s.text}`).join("\n");
  return `You are editing a short vertical clip cut from a podcast. The clip currently ENDS with these lines:
${close}

In the full video, these lines come right after the cut:
${next}

Does the clip end where the speaker has finished their point, or does the thought continue?
- If the point is complete, answer 0.
- If the next lines finish the same thought (the conclusion, the punchline, the rest of the sentence or story), answer the number of the LAST line needed to complete it.
- Never include a new question, a new topic or a transition.

Return ONLY JSON: {"keep": number}`;
}

export function parseEndCheck(jsonText: string, available: number): number {
  const stripped = jsonText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const keep = Number((JSON.parse(stripped) as { keep?: unknown })?.keep);
  return Number.isFinite(keep) ? Math.max(0, Math.min(available, Math.round(keep))) : 0;
}
