import OpenAI, { AuthenticationError, PermissionDeniedError, RateLimitError } from "openai";
import type { ModelProvider, AnalyzeResult } from "./types";
import { buildAnalysisPrompt, buildEndCheckPrompt, parseEndCheck, parseNormalizedClips, ProviderError, type EndChecker } from "./types";
import type { CustomProviderDef } from "../keystore";
import { romanizeInBatches } from "../gemini";

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
export function createOllamaRomanizer(def: CustomProviderDef, model: string): (words: string[]) => Promise<Array<string | null>> {
  const nativeUrl = def.baseUrl.replace(/\/v1\/?$/, "") + "/api/chat";
  return (words) =>
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
      def.label
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
        options: { num_ctx: OLLAMA_NUM_CTX, temperature: 0 },
      }),
    });
    const body: { message?: { content?: string }; error?: string } = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return parseEndCheck(body.message?.content ?? "", following.length);
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
