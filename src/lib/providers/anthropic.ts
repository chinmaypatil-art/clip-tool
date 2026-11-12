import Anthropic, { AuthenticationError, PermissionDeniedError, RateLimitError } from "@anthropic-ai/sdk";
import type { ModelProvider, AnalyzeResult } from "./types";
import { buildAnalysisPrompt, type NormalizedClip, ProviderError } from "./types";

const TOOL_NAME = "return_viral_clips";

const TOOL_SCHEMA = {
  name: TOOL_NAME,
  description: "Return the selected viral-worthy clips.",
  input_schema: {
    type: "object" as const,
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
        },
      },
    },
    required: ["clips"],
  },
};

export const anthropicProvider: ModelProvider = {
  id: "anthropic",
  label: "Anthropic Claude",
  models: [
    { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
  async analyze({ apiKey, model, segments, targetCount, range }): Promise<AnalyzeResult> {
    const client = new Anthropic({ apiKey });
    const start = Date.now();
    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: 4096,
        messages: [{ role: "user", content: buildAnalysisPrompt(segments, targetCount, range) }],
        tools: [TOOL_SCHEMA],
        tool_choice: { type: "tool", name: TOOL_NAME },
      });
    } catch (err) {
      throw classifyError(err);
    }

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === TOOL_NAME
    );
    if (!toolUse) throw new ProviderError("Claude did not return the expected tool call.", "other");

    const clipsRaw = (toolUse.input as { clips?: unknown[] })?.clips;
    if (!Array.isArray(clipsRaw)) throw new ProviderError("Claude's tool response was missing a 'clips' array.", "other");

    const clips: NormalizedClip[] = [];
    for (const c of clipsRaw) {
      const o = c as Record<string, unknown>;
      if (typeof o?.start_time === "number" && typeof o?.end_time === "number" && typeof o?.title === "string") {
        clips.push({
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

    return {
      clips,
      rawResponse: toolUse.input,
      tokenUsage: response.usage
        ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
        : null,
      durationMs: Date.now() - start,
    };
  },
};

function classifyError(err: unknown): ProviderError {
  const message = describeError(err);
  if (err instanceof RateLimitError) return new ProviderError(`Claude rate limit/quota exceeded: ${message}`, "rate_limit", err);
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    return new ProviderError(`Claude rejected this API key: ${message}`, "invalid_key", err);
  }
  return new ProviderError(`Claude request failed: ${message}`, "other", err);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
