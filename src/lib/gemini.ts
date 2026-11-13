import { GoogleGenAI, Type, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import type { ClipLengthRange } from "./clipLength";
import type { File as GeminiFile } from "@google/genai";
import type { TranscriptSegment } from "./transcript";

export class GeminiError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "GeminiError";
  }
}

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (client) return client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GeminiError(
      "GEMINI_API_KEY is not set. Add it to .env.local before running an analysis."
    );
  }
  client = new GoogleGenAI({ apiKey });
  return client;
}

const ANALYSIS_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
// Used when ANALYSIS_MODEL stays overloaded/out of quota after retries. A
// different model has its own free-tier quota and capacity pool.
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL ?? "gemini-2.5-flash";
const RETRY_DELAYS_MS = [4_000, 10_000, 20_000];

/** 503 overloaded, 500, 429 rate/quota, and dropped connections are worth retrying; bad requests are not. */
function isTransientGeminiError(err: unknown): boolean {
  return /\b(429|500|502|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL|overloaded|high demand|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(
    describeError(err)
  );
}

/**
 * generateContent with backoff on transient errors (free-tier Gemini returns
 * 503 "high demand" and 429 routinely — one of those used to throw away a
 * whole job). If the model is still failing after all retries, tries
 * FALLBACK_MODEL once before giving up.
 */
async function generateWithRetry(ai: GoogleGenAI, params: GenerateContentParameters): Promise<GenerateContentResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      lastErr = err;
      if (!isTransientGeminiError(err) || attempt === RETRY_DELAYS_MS.length) break;
      console.error(`[gemini] ${params.model} transient error, retry ${attempt + 1}/${RETRY_DELAYS_MS.length}:`, describeError(err));
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  if (isTransientGeminiError(lastErr) && FALLBACK_MODEL && FALLBACK_MODEL !== params.model) {
    console.error(`[gemini] ${params.model} still failing, falling back to ${FALLBACK_MODEL}`);
    return ai.models.generateContent({ ...params, model: FALLBACK_MODEL });
  }
  throw lastErr;
}

/** Uploads a local video file to Gemini's Files API and waits until it's ACTIVE (processed, queryable). */
export async function uploadVideo(filePath: string, mimeType: string): Promise<GeminiFile> {
  const ai = getClient();
  let file: GeminiFile;
  try {
    file = await ai.files.upload({ file: filePath, config: { mimeType } });
  } catch (err) {
    throw new GeminiError(`Failed to upload video to Gemini Files API: ${describeError(err)}`, err);
  }

  if (!file.name) throw new GeminiError("Gemini Files API did not return a file name after upload.");
  const fileName = file.name;

  const maxWaitMs = 10 * 60 * 1000;
  const pollIntervalMs = 3000;
  const start = Date.now();
  while (file.state === "PROCESSING") {
    if (Date.now() - start > maxWaitMs) {
      throw new GeminiError("Timed out waiting for Gemini to finish processing the uploaded video.");
    }
    await sleep(pollIntervalMs);
    try {
      file = await ai.files.get({ name: fileName });
    } catch (err) {
      throw new GeminiError(`Failed to poll Gemini file status: ${describeError(err)}`, err);
    }
  }

  if (file.state === "FAILED") {
    throw new GeminiError(`Gemini failed to process the uploaded video: ${file.error?.message ?? "unknown error"}`);
  }

  return file;
}

export interface RawCandidate {
  startSeconds: number;
  endSeconds: number;
  title: string;
  reason: string;
  score: number;
}

const TRANSCRIPT_CANDIDATE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    candidates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          startSeconds: { type: Type.NUMBER, description: "Clip start, in seconds, ABSOLUTE within the full video (matches the transcript's own timestamps)." },
          endSeconds: { type: Type.NUMBER, description: "Clip end, in seconds, ABSOLUTE within the full video." },
          title: { type: Type.STRING, description: "Short punchy working title, 10 words max." },
          reason: { type: Type.STRING, description: "Why this moment has short-form viral/hook potential." },
          score: { type: Type.NUMBER, description: "Viral/hook potential from 0-100." },
        },
        required: ["startSeconds", "endSeconds", "title", "reason", "score"],
      },
    },
  },
  required: ["candidates"],
};

const TRANSCRIPT_PROMPT = `You are an expert short-form video editor who finds viral clip-worthy moments inside long-form video/podcast/interview content, working from a TIMESTAMPED TRANSCRIPT (you cannot see the video itself).

Below is the full transcript, as timestamped segments (seconds from the start of the video):

{transcript}

Find the {targetCount} best candidate clips for short-form content (Reels/Shorts/TikTok). A good candidate:
- Works as a STANDALONE clip — no earlier context needed to understand or care about it.
- Has a strong hook in its opening line (bold claim, question, emotional beat, surprising fact).
- Is a complete thought/story/exchange, not a mid-idea cutoff.
- Is between {minSeconds} and {maxSeconds} seconds long. This length range is a hard requirement set by the user.
- For interviews/podcasts: start the clip on the interviewer's question or setup line, not mid-answer, so the viewer sees both people and gets the context.
- End the clip right after the payoff/punchline line. NEVER include the start of the next question, a new topic, or a transition line after the payoff — that ruins the clip. If the moment is shorter than the range, add setup context BEFORE it, never extra lines after it; a slightly short clean clip beats a padded one.
- Has genuine substance — not just filler or someone trailing off.

Pick clips spread across the video rather than clustering in one stretch, and make sure none of them overlap in time. Return startSeconds/endSeconds as ABSOLUTE video time (matching the transcript's own timestamps), not relative to any window.`;

/**
 * Transcript-only analysis path (no video upload): for YouTube sources we
 * have an accurate, officially-sourced transcript, so there's no need to pay
 * for/wait on video upload + chunked window analysis — one text-only call
 * covers the whole video and returns absolute timestamps directly.
 */
export async function analyzeTranscript(
  segments: TranscriptSegment[],
  targetCount: number,
  range: ClipLengthRange
): Promise<RawCandidate[]> {
  const ai = getClient();
  const transcriptText = segments
    .map((s) => `[${(s.startMs / 1000).toFixed(1)}s - ${(s.endMs / 1000).toFixed(1)}s] ${s.text}`)
    .join("\n");

  let response;
  try {
    response = await generateWithRetry(ai, {
      model: ANALYSIS_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: fillLength(
                TRANSCRIPT_PROMPT.replace("{transcript}", transcriptText).replace("{targetCount}", String(targetCount)),
                range
              ),
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: TRANSCRIPT_CANDIDATE_SCHEMA,
      },
    });
  } catch (err) {
    throw new GeminiError(`Gemini transcript analysis failed: ${describeError(err)}`, err);
  }

  const text = response.text;
  if (!text) throw new GeminiError("Gemini transcript analysis returned no output.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new GeminiError("Gemini transcript analysis returned invalid JSON.", err);
  }

  const candidatesRaw = (parsed as { candidates?: unknown[] })?.candidates;
  if (!Array.isArray(candidatesRaw)) throw new GeminiError("Gemini transcript analysis response missing 'candidates' array.");

  const out: RawCandidate[] = [];
  for (const c of candidatesRaw) {
    if (
      typeof c === "object" &&
      c !== null &&
      typeof (c as RawCandidate).startSeconds === "number" &&
      typeof (c as RawCandidate).endSeconds === "number" &&
      typeof (c as RawCandidate).title === "string" &&
      typeof (c as RawCandidate).reason === "string" &&
      typeof (c as RawCandidate).score === "number"
    ) {
      out.push(c as RawCandidate);
    }
  }
  return out;
}

const CANDIDATE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    candidates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          startSeconds: { type: Type.NUMBER, description: "Clip start, in seconds, relative to the start of THIS video window (not the full video)." },
          endSeconds: { type: Type.NUMBER, description: "Clip end, in seconds, relative to the start of THIS video window." },
          title: { type: Type.STRING, description: "Short punchy working title for this moment, 10 words max." },
          reason: { type: Type.STRING, description: "Why this moment has short-form viral/hook potential — be specific about what happens." },
          score: { type: Type.NUMBER, description: "Viral/hook potential from 0-100." },
        },
        required: ["startSeconds", "endSeconds", "title", "reason", "score"],
      },
    },
  },
  required: ["candidates"],
};

const CHUNK_PROMPT = `You are an expert short-form video editor who finds viral clip-worthy moments inside long-form video/podcast/interview content (the kind of moments that work as standalone Instagram Reels, YouTube Shorts, or TikToks).

You are looking at ONE WINDOW of a longer video, spanning from {windowStart}s to {windowEnd}s of the full video. Analyze only what is shown/heard in this window.

Find 0 to 3 candidate clips in this window that would make compelling short-form content. A good candidate:
- Works as a STANDALONE clip — the viewer doesn't need earlier context to understand or care about it.
- Has a strong hook in the first 1-2 seconds (bold claim, question, emotional beat, surprising fact, visual moment).
- Is a complete thought/story/exchange — doesn't cut off mid-idea.
- Is between {minSeconds} and {maxSeconds} seconds long. This length range is a hard requirement set by the user.
- For interviews/podcasts: start the clip on the interviewer's question or setup line, not mid-answer, so the viewer sees both people and gets the context.
- End the clip right after the payoff/punchline line. NEVER include the start of the next question, a new topic, or a transition line after the payoff — that ruins the clip. If the moment is shorter than the range, add setup context BEFORE it, never extra lines after it; a slightly short clean clip beats a padded one.
- Benefits from genuine delivery, energy, pacing, or a punchline/payoff, not just someone talking in a monotone about something unremarkable.

If there is nothing good in this window, return an empty candidates array — do not force low-quality picks.

All startSeconds/endSeconds you return MUST be relative to the start of this window (i.e. the first frame you see is time 0), not the absolute video time.`;

/** Analyzes one time-window of the uploaded video and returns raw (window-relative) candidates. */
export async function analyzeWindow(
  file: GeminiFile,
  windowStartSeconds: number,
  windowEndSeconds: number,
  range: ClipLengthRange
): Promise<RawCandidate[]> {
  const ai = getClient();
  if (!file.uri || !file.mimeType) {
    throw new GeminiError("Uploaded file is missing uri/mimeType; cannot analyze.");
  }

  let response;
  try {
    response = await generateWithRetry(ai, {
      model: ANALYSIS_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              fileData: { fileUri: file.uri, mimeType: file.mimeType },
              videoMetadata: {
                startOffset: `${windowStartSeconds}s`,
                endOffset: `${windowEndSeconds}s`,
              },
            },
            {
              text: fillLength(
                CHUNK_PROMPT.replace("{windowStart}", windowStartSeconds.toFixed(0)).replace(
                  "{windowEnd}",
                  windowEndSeconds.toFixed(0)
                ),
                range
              ),
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: CANDIDATE_SCHEMA,
      },
    });
  } catch (err) {
    throw new GeminiError(
      `Gemini analysis failed for window [${windowStartSeconds}s-${windowEndSeconds}s]: ${describeError(err)}`,
      err
    );
  }

  const text = response.text;
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Model deviated from schema; treat as "no usable candidates" rather than crashing the whole job.
    return [];
  }

  const candidatesRaw = (parsed as { candidates?: unknown[] })?.candidates;
  if (!Array.isArray(candidatesRaw)) return [];

  const out: RawCandidate[] = [];
  for (const c of candidatesRaw) {
    if (
      typeof c === "object" &&
      c !== null &&
      typeof (c as RawCandidate).startSeconds === "number" &&
      typeof (c as RawCandidate).endSeconds === "number" &&
      typeof (c as RawCandidate).title === "string" &&
      typeof (c as RawCandidate).reason === "string" &&
      typeof (c as RawCandidate).score === "number"
    ) {
      out.push(c as RawCandidate);
    }
  }
  return out;
}

export interface RankedClip {
  startSeconds: number;
  endSeconds: number;
  title: string;
  reason: string;
  score: number;
}

const RANKING_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    picks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          startSeconds: { type: Type.NUMBER },
          endSeconds: { type: Type.NUMBER },
          title: { type: Type.STRING },
          reason: { type: Type.STRING },
          score: { type: Type.NUMBER },
        },
        required: ["startSeconds", "endSeconds", "title", "reason", "score"],
      },
    },
  },
  required: ["picks"],
};

/**
 * Given all candidates gathered across every analyzed window (already converted
 * to absolute video time), asks Gemini (text-only, no video re-upload) to select
 * the final 5: highest overall hook potential, non-overlapping, diverse.
 */
export async function rankCandidates(
  candidates: Array<RawCandidate & { absoluteStart: number; absoluteEnd: number }>,
  targetCount: number,
  range: ClipLengthRange
): Promise<RankedClip[]> {
  if (candidates.length === 0) return [];

  const ai = getClient();
  const listing = candidates
    .map(
      (c, i) =>
        `${i}. [${c.absoluteStart.toFixed(0)}s-${c.absoluteEnd.toFixed(0)}s] "${c.title}" (model score ${c.score}): ${c.reason}`
    )
    .join("\n");

  const prompt = `Below is a list of candidate short-form clip moments extracted from a single long video, with their ABSOLUTE timestamps in the full video.

${listing}

Select the best ${targetCount} clips overall. Prioritize:
- Highest genuine viral/hook potential (not just highest model score — use your own judgment).
- No two selected clips should overlap in time.
- Each clip must be between ${range.minSeconds} and ${range.maxSeconds} seconds long (the user's choice). You may tighten or extend a candidate's start/end to land in that range, as long as it still starts and ends on a complete thought.
- Prefer variety (different topics/moments) over picking several near-duplicate moments from the same stretch of video.
- If fewer than ${targetCount} candidates are actually good, return fewer rather than padding with weak picks.

Return startSeconds/endSeconds as the ABSOLUTE timestamps (same numbers as given above, not re-zeroed).`;

  let response;
  try {
    response = await generateWithRetry(ai, {
      model: ANALYSIS_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: RANKING_SCHEMA,
      },
    });
  } catch (err) {
    throw new GeminiError(`Gemini ranking pass failed: ${describeError(err)}`, err);
  }

  const text = response.text;
  if (!text) throw new GeminiError("Gemini ranking pass returned no output.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new GeminiError("Gemini ranking pass returned invalid JSON.", err);
  }

  const picks = (parsed as { picks?: unknown[] })?.picks;
  if (!Array.isArray(picks)) throw new GeminiError("Gemini ranking pass response missing 'picks' array.");

  const out: RankedClip[] = [];
  for (const p of picks) {
    if (
      typeof p === "object" &&
      p !== null &&
      typeof (p as RankedClip).startSeconds === "number" &&
      typeof (p as RankedClip).endSeconds === "number" &&
      typeof (p as RankedClip).title === "string" &&
      typeof (p as RankedClip).reason === "string" &&
      typeof (p as RankedClip).score === "number"
    ) {
      out.push(p as RankedClip);
    }
  }
  return out;
}

const ROMANIZE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    words: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { i: { type: Type.INTEGER }, text: { type: Type.STRING } },
        required: ["i", "text"],
      },
    },
  },
  required: ["words"],
};
const ROMANIZE_BATCH = 80; // short lists keep the model from merging/skipping items

/**
 * Rewrites caption words (Whisper output: Devanagari mixed with Latin) as
 * romanised Hinglish — the spelling used in Reels/Shorts captions. Words go
 * out numbered and come back matched by number, so every word keeps its own
 * timestamp. Entries the model didn't return are null; the caller falls back
 * to rule-based transliteration for those. `ask` sends one prompt to whichever
 * model is doing the work and returns its raw JSON text.
 */
export async function romanizeInBatches(
  words: string[],
  ask: (prompt: string) => Promise<string>,
  label: string,
  reference?: string
): Promise<Array<string | null>> {
  const result: Array<string | null> = words.map(() => null);
  const batches: number[] = [];
  for (let start = 0; start < words.length; start += ROMANIZE_BATCH) batches.push(start);

  await Promise.all(
    batches.map(async (start) => {
      const batch = words.slice(start, start + ROMANIZE_BATCH);
      const prompt = `Numbered words from a Hindi/Hinglish speech transcript, in order. Some are in Devanagari, some already in Latin script.

Rewrite each word in Latin script the way Indians write Hinglish in Instagram/YouTube captions:
- Hindi words: common Hinglish spelling ("हैं" -> "hain", "नहीं" -> "nahi", "करना" -> "karna", "ज़्यादा" -> "zyada").
- English words written in Devanagari: normal English spelling ("क्रिएटर्स" -> "creators", "मॉडल्स" -> "models").
- Words already in Latin script: keep them; only drop stray accents ("bäťe" -> "baithe") and fix clearly broken Hinglish spellings.
- Keep punctuation attached to its word. Never translate.
${
        reference
          ? `- The speech recognizer sometimes mishears a word ("ignay se hubhu" for "ekdam se hoobahoo"). The video's own captions for this stretch are below; where a numbered word is clearly a mishearing of a word there, write the captions' word instead. They may be a translation, so never copy words that weren't said, and keep one output word per number.
  Captions: ${reference}
`
          : ""
      }

Return JSON {"words": [{"i": <number>, "text": <word>}, ...]} with one object for every number below.

${batch.map((w, k) => `${k}: ${w}`).join("\n")}`;

      try {
        const parsed: unknown = JSON.parse(await ask(prompt));
        const items = Array.isArray(parsed) ? parsed : (parsed as { words?: unknown })?.words;
        if (!Array.isArray(items)) throw new Error("response has no words array");
        for (const item of items) {
          const { i, text } = (item ?? {}) as { i?: unknown; text?: unknown };
          if (typeof i === "number" && Number.isInteger(i) && i >= 0 && i < batch.length && typeof text === "string") {
            result[start + i] = text.trim() || null;
          }
        }
      } catch (err) {
        // Leave this batch null so only its words fall back, not the whole clip.
        console.error(`[${label}] romanization batch at word ${start} failed:`, describeError(err));
      }
    })
  );
  return result;
}

export async function romanizeHinglishWords(words: string[], reference?: string): Promise<Array<string | null>> {
  const ai = getClient();
  return romanizeInBatches(
    words,
    async (prompt) => {
      const response = await generateWithRetry(ai, {
        model: ANALYSIS_MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json", responseSchema: ROMANIZE_SCHEMA },
      });
      return response.text ?? "";
    },
    "gemini",
    reference
  );
}

function fillLength(prompt: string, range: ClipLengthRange): string {
  return prompt.replaceAll("{minSeconds}", String(range.minSeconds)).replaceAll("{maxSeconds}", String(range.maxSeconds));
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
