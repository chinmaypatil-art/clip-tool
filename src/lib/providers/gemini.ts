import { GoogleGenAI, Type } from "@google/genai";
import type { ModelProvider, AnalyzeResult } from "./types";
import { buildAnalysisPrompt, parseNormalizedClips, ProviderError } from "./types";

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    clips: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          start_time: { type: Type.NUMBER },
          end_time: { type: Type.NUMBER },
          title: { type: Type.STRING },
          hook: { type: Type.STRING },
          description: { type: Type.STRING },
          reasoning: { type: Type.STRING },
          viral_score: { type: Type.NUMBER },
          category: { type: Type.STRING },
          engagement_potential: { type: Type.STRING },
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
      },
    },
  },
  required: ["clips"],
};

export const geminiProvider: ModelProvider = {
  id: "gemini",
  label: "Google Gemini",
  models: [
    { id: "gemini-flash-latest", label: "Gemini Flash (latest)", free: true },
    { id: "gemini-pro-latest", label: "Gemini Pro (latest)" },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite", free: true },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", free: true },
  ],
  async analyze({ apiKey, model, segments, targetCount, range }): Promise<AnalyzeResult> {
    const ai = new GoogleGenAI({ apiKey });
    const start = Date.now();
    let response;
    try {
      response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: buildAnalysisPrompt(segments, targetCount, range) }] }],
        config: { responseMimeType: "application/json", responseSchema: SCHEMA },
      });
    } catch (err) {
      throw classifyError(err);
    }

    const text = response.text;
    if (!text) throw new ProviderError("Gemini returned no output.", "other");

    let clips;
    try {
      clips = parseNormalizedClips(text);
    } catch (err) {
      throw new ProviderError(`Gemini response failed schema validation: ${describeError(err)}`, "other", err);
    }

    return {
      clips,
      rawResponse: text,
      tokenUsage: response.usageMetadata
        ? {
            inputTokens: response.usageMetadata.promptTokenCount ?? undefined,
            outputTokens: response.usageMetadata.candidatesTokenCount ?? undefined,
          }
        : null,
      durationMs: Date.now() - start,
    };
  },
};

function classifyError(err: unknown): ProviderError {
  const status = (err as { status?: number })?.status;
  const message = describeError(err);
  if (status === 429) return new ProviderError(`Gemini rate limit/quota exceeded: ${message}`, "rate_limit", err);
  if (status === 401 || status === 403) return new ProviderError(`Gemini rejected this API key: ${message}`, "invalid_key", err);
  return new ProviderError(`Gemini request failed: ${message}`, "other", err);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
