import OpenAI, { AuthenticationError, PermissionDeniedError, RateLimitError } from "openai";
import type { ModelProvider, AnalyzeResult, NormalizedClip, WindowedPicker } from "./types";
import {
  buildAnalysisPrompt,
  buildEndCheckPrompt,
  buildWindowClipPrompt,
  buildWindowScorePrompt,
  parseEndCheck,
  parseNormalizedClips,
  parseWindowScores,
  ProviderError,
  type EndChecker,
} from "./types";
import type { CustomProviderDef } from "../keystore";
import { romanizeInBatches } from "../gemini";
import { buildTranscriptWindows, pickWindowSeconds } from "../transcriptWindows";

/**
 * Builds a provider for any service that speaks the OpenAI chat-completions
 * API (Groq, OpenRouter, Together, DeepSeek, Mistral, xAI, a local Ollama…).
 * The user supplies the base URL and model ids; we only rely on the subset of
 * the API they all share: chat.completions with a JSON-object response.
 */
export function createOpenAICompatibleProvider(def: CustomProviderDef): ModelProvider {
  return {
    id: def.id,
    label: def.label,
    models: def.models.map((m) => ({ id: m, label: m })),
    async analyze({ apiKey, model, segments, targetCount, range }): Promise<AnalyzeResult> {
      if (isOllama(def.baseUrl)) return analyzeWithOllama(def, model, buildAnalysisPrompt(segments, targetCount, range));
      const client = new OpenAI({ apiKey, baseURL: def.baseUrl });
      const start = Date.now();
      let response;
      try {
        response = await client.chat.completions.create({
          model,
          messages: [{ role: "user", content: buildAnalysisPrompt(segments, targetCount, range) }],
          response_format: { type: "json_object" },
        });
      } catch (err) {
        throw classifyError(def.label, err);
      }

      const text = response.choices[0]?.message?.content;
      if (!text) throw new ProviderError(`${def.label} returned no output.`, "other");

      let clips;
      try {
        clips = parseNormalizedClips(text);
      } catch (err) {
        throw new ProviderError(`${def.label} response failed schema validation: ${describeError(err)}`, "other", err);
      }

      return {
        clips,
        rawResponse: text,
        tokenUsage: response.usage
          ? { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens }
          : null,
        durationMs: Date.now() - start,
      };
    },
  };
}

const isOllama = (baseUrl: string) => /:11434(\/|$)/.test(baseUrl);

// One context size for every call: Ollama reloads the model whenever num_ctx
// changes, which made each end check and caption batch wait ~40s.
// Ollama's OpenAI-compatible endpoint silently truncates prompts to its small
// default context window (a 38-min transcript is ~16k tokens), and there's no
// way to raise it through that endpoint. Its native /api/chat takes num_ctx.
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 32_768);

async function analyzeWithOllama(def: CustomProviderDef, model: string, prompt: string): Promise<AnalyzeResult> {
  const start = Date.now();
  const nativeUrl = def.baseUrl.replace(/\/v1\/?$/, "") + "/api/chat";
  let body: {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
    error?: string;
  };
  try {
    const res = await fetch(nativeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        format: "json",
        stream: false,
        think: false,
        options: { num_ctx: OLLAMA_NUM_CTX, temperature: 0.4 },
      }),
    });
    body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  } catch (err) {
    throw new ProviderError(
      `${def.label} request failed (is Ollama running at ${def.baseUrl}?): ${describeError(err)}`,
      "other",
      err
    );
  }

  const text = body.message?.content;
  if (!text) throw new ProviderError(`${def.label} returned no output.`, "other");
  let clips;
  try {
    clips = parseNormalizedClips(text);
  } catch (err) {
    throw new ProviderError(`${def.label} response failed schema validation: ${describeError(err)}`, "other", err);
  }
  return {
    clips,
    rawResponse: text,
    tokenUsage: { inputTokens: body.prompt_eval_count, outputTokens: body.eval_count },
    durationMs: Date.now() - start,
  };
}

/** Romanizes caption words with the same local Ollama model that picked the clips, so rendering needs no cloud API. */
export function createOllamaRomanizer(
  def: CustomProviderDef,
  model: string
): (words: string[], reference?: string) => Promise<Array<string | null>> {
  const nativeUrl = def.baseUrl.replace(/\/v1\/?$/, "") + "/api/chat";
  return (words, reference) =>
    romanizeInBatches(
      words,
      async (prompt) => {
        const res = await fetch(nativeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            format: "json",
            stream: false,
            think: false,
            options: { num_ctx: OLLAMA_NUM_CTX, temperature: 0 },
          }),
        });
        const body: { message?: { content?: string }; error?: string } = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        return body.message?.content ?? "";
      },
      def.label,
      reference
    );
}

/** Asks a local Ollama model whether a clip's last line finishes the speaker's point. */
export function createOllamaEndChecker(def: CustomProviderDef, model: string): EndChecker {
  const nativeUrl = def.baseUrl.replace(/\/v1\/?$/, "") + "/api/chat";
  return async ({ inside, following }) => {
    const res = await fetch(nativeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: buildEndCheckPrompt(inside, following) }],
        format: "json",
        stream: false,
        think: false,
        options: { num_ctx: OLLAMA_NUM_CTX, num_predict: 64, temperature: 0 },
      }),
    });
    const body: { message?: { content?: string }; error?: string } = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return parseEndCheck(body.message?.content ?? "", inside.length, following.length);
  };
}

// Windows per scoring call: three few-minute excerpts fit the context with
// room to spare.
const SCORE_BATCH = 3;
// Output caps: a scoring answer is a few lines, a window's clips about 600
// tokens. gemma3:12b sometimes loops on one token until Ollama aborts the
// call ("token repeat limit reached"), which took 8.5 min once.
const SCORE_MAX_TOKENS = 512;
const CLIPS_MAX_TOKENS = 1024;

/**
 * Picks clips in two passes, as openshorts does: score few-minute windows of
 * the transcript, then find clips inside the best ones, one window per call.
 * Over a whole 55-min transcript in one call, gemma3:12b put every pick in
 * the first 8 minutes and returned 16-39s clips for a 60s minimum.
 * A window whose call fails is retried once, then skipped.
 */
export function createOllamaWindowedPicker(def: CustomProviderDef, model: string): WindowedPicker {
  const nativeUrl = def.baseUrl.replace(/\/v1\/?$/, "") + "/api/chat";
  let usage = { inputTokens: 0, outputTokens: 0 };
  const chat = async (prompt: string, temperature: number, maxTokens: number) => {
    let res: Response;
    try {
      res = await fetch(nativeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          format: "json",
          stream: false,
          think: false,
          options: { num_ctx: OLLAMA_NUM_CTX, num_predict: maxTokens, temperature },
        }),
      });
    } catch (err) {
      // Ollama itself is unreachable: no point trying the other windows.
      throw new ProviderError(`${def.label} request failed (is Ollama running at ${def.baseUrl}?): ${describeError(err)}`, "other", err);
    }
    const body: { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; error?: string } =
      await res.json();
    usage.inputTokens += body.prompt_eval_count ?? 0;
    usage.outputTokens += body.eval_count ?? 0;
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body.message?.content ?? "";
  };
  // One retry, a little warmer: a repeat loop rarely happens twice.
  const attempt = async <T>(label: string, run: (temperature: number) => Promise<T>, temperature: number): Promise<T | null> => {
    for (const t of [temperature, temperature + 0.3]) {
      try {
        return await run(t);
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        console.error(`[${def.label}] ${label} failed at temperature ${t}:`, describeError(err));
      }
    }
    return null;
  };

  return async ({ segments, targetCount, range }) => {
    const start = Date.now();
    usage = { inputTokens: 0, outputTokens: 0 };
    const windows = buildTranscriptWindows(segments, pickWindowSeconds(range));

    const scores = new Map<string, number>();
    for (let b = 0; b < windows.length; b += SCORE_BATCH) {
      const batch = windows.slice(b, b + SCORE_BATCH);
      const scored = await attempt(
        `scoring windows ${batch.map((w) => w.id).join(",")}`,
        async (t) => parseWindowScores(await chat(buildWindowScorePrompt(batch), t, SCORE_MAX_TOKENS)),
        0.2
      );
      for (const [id, score] of scored ?? []) scores.set(id, score);
    }
    // Unscored windows rank last but stay in play; ties keep video order.
    const shortlist = [...windows]
      .sort((a, b) => (scores.get(b.id) ?? -1) - (scores.get(a.id) ?? -1))
      .slice(0, Math.min(windows.length, targetCount))
      .sort((a, b) => a.startSeconds - b.startSeconds);

    const clips: NormalizedClip[] = [];
    const raw: Array<{ window: string; score: number | null; response: string | null }> = [];
    for (const w of shortlist) {
      let text: string | null = null;
      const found = await attempt(
        `clips for window ${w.id}`,
        async (t) => {
          text = await chat(buildWindowClipPrompt(w.segments, range), t, CLIPS_MAX_TOKENS);
          return parseNormalizedClips(text);
        },
        0.4
      );
      raw.push({ window: `${w.id} ${w.startSeconds.toFixed(0)}-${w.endSeconds.toFixed(0)}s`, score: scores.get(w.id) ?? null, response: text });
      // A clip ranks by its window too: gemma rates nearly every clip 75-85, and
      // on that alone the early windows crowded out the rest of the video.
      const windowScore = scores.get(w.id);
      for (const c of found ?? []) clips.push(windowScore === undefined ? c : { ...c, viralScore: Math.round((c.viralScore + windowScore) / 2) });
    }
    if (!clips.length) throw new ProviderError(`${def.label} found no clips in any window.`, "other");
    return { clips, rawResponse: raw, tokenUsage: { ...usage }, durationMs: Date.now() - start };
  };
}

export { isOllama };

function classifyError(label: string, err: unknown): ProviderError {
  const message = describeError(err);
  if (err instanceof RateLimitError) return new ProviderError(`${label} rate limit/quota exceeded: ${message}`, "rate_limit", err);
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    return new ProviderError(`${label} rejected this API key: ${message}`, "invalid_key", err);
  }
  return new ProviderError(`${label} request failed: ${message}`, "other", err);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
