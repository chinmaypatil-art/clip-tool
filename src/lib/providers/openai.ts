import OpenAI, { AuthenticationError, PermissionDeniedError, RateLimitError } from "openai";
import type { ModelProvider, AnalyzeResult } from "./types";
import { buildAnalysisPrompt, parseNormalizedClips, ProviderError } from "./types";

const CLIP_JSON_SCHEMA = {
  name: "viral_clips",
  schema: {
    type: "object",
    properties: {
      clips: {
        type: "array",
        items: {
          type: "object",
          properties: {
            start_time: { type: "number" },
            end_time: { type: "number" },
            title: { type: "string" },
            hook: { type: "string" },
            description: { type: "string" },
            reasoning: { type: "string" },
            viral_score: { type: "number" },
            category: { type: "string" },
            engagement_potential: { type: "string" },
          },
          required: [
            "start_time",
            "end_time",
            "title",
            "hook",
            "description",
            "reasoning",
            "viral_score",
            "category",
            "engagement_potential",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["clips"],
    additionalProperties: false,
  },
  strict: true,
};

export const openaiProvider: ModelProvider = {
  id: "openai",
  label: "OpenAI",
  models: [
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "gpt-4o-mini", label: "GPT-4o mini" },
    { id: "gpt-4.1", label: "GPT-4.1" },
  ],
  async analyze({ apiKey, model, segments, targetCount, range }): Promise<AnalyzeResult> {
    const client = new OpenAI({ apiKey });
    const start = Date.now();
    let response;
    try {
      response = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: buildAnalysisPrompt(segments, targetCount, range) }],
        response_format: { type: "json_schema", json_schema: CLIP_JSON_SCHEMA },
      });
    } catch (err) {
      throw classifyError(err);
    }

    const text = response.choices[0]?.message?.content;
    if (!text) throw new ProviderError("OpenAI returned no output.", "other");

    let clips;
    try {
      clips = parseNormalizedClips(text);
    } catch (err) {
      throw new ProviderError(`OpenAI response failed schema validation: ${describeError(err)}`, "other", err);
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

function classifyError(err: unknown): ProviderError {
  const message = describeError(err);
  if (err instanceof RateLimitError) return new ProviderError(`OpenAI rate limit/quota exceeded: ${message}`, "rate_limit", err);
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    return new ProviderError(`OpenAI rejected this API key: ${message}`, "invalid_key", err);
  }
  return new ProviderError(`OpenAI request failed: ${message}`, "other", err);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
