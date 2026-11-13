import type { ModelProvider } from "./types";
import { ProviderError } from "./types";
import { geminiProvider } from "./gemini";
import { openaiProvider } from "./openai";
import { anthropicProvider } from "./anthropic";
import { getEligibleKeys, advanceRotation, markRateLimited, markInvalid, recordUsage, listCustomProviders, listKeys, isLocalBaseUrl } from "../keystore";
import { createOpenAICompatibleProvider, createOllamaEndChecker, createOllamaRomanizer, isOllama } from "./openaiCompatible";
import type { Romanizer } from "../whisper";
import type { Provider } from "../keystore";
import type { TranscriptSegment } from "../transcript";
import type { AnalyzeResult, EndChecker } from "./types";
import type { ClipLengthRange } from "../clipLength";

export const PROVIDERS: Record<string, ModelProvider> = {
  gemini: geminiProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
};

/** Looks up a built-in provider, or a user-added OpenAI-compatible one. */
export async function getProvider(id: Provider): Promise<ModelProvider | undefined> {
  if (PROVIDERS[id]) return PROVIDERS[id];
  const def = (await listCustomProviders()).find((p) => p.id === id);
  return def ? createOpenAICompatibleProvider(def) : undefined;
}

// Custom providers on these hosts have a free API tier (Groq) or run locally (Ollama).
const FREE_HOSTS = [/api\.groq\.com/i, /localhost|127\.0\.0\.1/i];

/**
 * Built-in + user-added providers. `hasKey` = at least one usable (enabled,
 * not invalid) key is stored, so the UI can hide providers that would fail.
 */
export async function listAllProviders() {
  const keys = await listKeys();
  const hasKey = (id: string) => keys.some((k) => k.provider === id && k.enabled && !k.invalid);
  const builtins = Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    models: p.models,
    custom: false,
    hasKey: hasKey(p.id),
  }));
  const customs = (await listCustomProviders()).map((d) => {
    const free = FREE_HOSTS.some((re) => re.test(d.baseUrl));
    return {
      id: d.id,
      label: d.label,
      models: d.models.map((m) => ({ id: m, label: m, free })),
      custom: true,
      baseUrl: d.baseUrl,
      hasKey: hasKey(d.id) || isLocalBaseUrl(d.baseUrl),
    };
  });
  return [...builtins, ...customs];
}

export interface RunMetadata {
  keyId: string;
  keyLabel: string;
  attempts: number;
}

/**
 * Runs an analysis against a provider/model, rotating through that
 * provider's eligible API keys on rate-limit errors. Stops (does not retry)
 * on an invalid-key error for THAT key, trying the next eligible one instead.
 * Caps total attempts at the number of eligible keys — never loops forever.
 */
const TRANSIENT_RETRY_DELAYS_MS = [4_000, 10_000, 20_000];

/** Server-side hiccups (503 overloaded, 5xx, dropped connection) — same key, just try again shortly. */
function isTransient(err: unknown): boolean {
  if (err instanceof ProviderError && err.kind !== "other") return false;
  const message = err instanceof Error ? err.message : String(err);
  return /\b(500|502|503|504)\b|UNAVAILABLE|overloaded|high demand|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message);
}

async function withTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err) || attempt >= TRANSIENT_RETRY_DELAYS_MS.length) throw err;
      await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_DELAYS_MS[attempt]));
    }
  }
}

export async function runAnalysis(
  providerId: Provider,
  model: string,
  segments: TranscriptSegment[],
  targetCount: number,
  range: ClipLengthRange
): Promise<AnalyzeResult & { meta: RunMetadata }> {
  const provider = await getProvider(providerId);
  if (!provider) throw new ProviderError(`Unknown provider "${providerId}".`, "other");

  const keys = await getEligibleKeys(providerId);
  if (keys.length === 0) {
    const def = (await listCustomProviders()).find((p) => p.id === providerId);
    if (def && isLocalBaseUrl(def.baseUrl)) {
      // Local server: any placeholder works, nothing to rotate or record.
      const result = await withTransientRetry(() => provider.analyze({ apiKey: "local", model, segments, targetCount, range }));
      return { ...result, meta: { keyId: "local", keyLabel: "local (no key)", attempts: 1 } };
    }
  }
  if (keys.length === 0) {
    throw new ProviderError(
      `No enabled API key available for ${provider.label}. Add one in API Key Management first.`,
      "other"
    );
  }

  let lastError: ProviderError | null = null;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = keys[attempt];
    try {
      const result = await withTransientRetry(() => provider.analyze({ apiKey: key.value, model, segments, targetCount, range }));
      await recordUsage(key.id);
      await advanceRotation(providerId);
      return { ...result, meta: { keyId: key.id, keyLabel: key.label, attempts: attempt + 1 } };
    } catch (err) {
      const providerErr = err instanceof ProviderError ? err : new ProviderError(String(err), "other", err);
      lastError = providerErr;
      if (providerErr.kind === "rate_limit") {
        await markRateLimited(key.id, providerErr.message);
        continue; // try the next eligible key
      }
      if (providerErr.kind === "invalid_key") {
        await markInvalid(key.id, providerErr.message);
        continue; // try the next eligible key
      }
      // Any other error (schema validation, network, etc.) is not a key
      // problem — retrying with a different key won't help, so stop here.
      throw providerErr;
    }
  }

  throw lastError ?? new ProviderError(`All eligible ${provider.label} keys failed.`, "other");
}

/**
 * Local models also handle caption romanization, so a run that picked clips
 * with Ollama renders without touching any cloud API. Undefined = default (Gemini).
 */
export async function getLocalRomanizer(providerId: string, model: string): Promise<Romanizer | undefined> {
  const def = (await listCustomProviders()).find((p) => p.id === providerId);
  if (!def || !isOllama(def.baseUrl)) return undefined;
  return createOllamaRomanizer(def, model);
}

/** Local models also check that each clip ends on a finished thought. Undefined for cloud models. */
export async function getLocalEndChecker(providerId: string, model: string): Promise<EndChecker | undefined> {
  const def = (await listCustomProviders()).find((p) => p.id === providerId);
  if (!def || !isOllama(def.baseUrl)) return undefined;
  return createOllamaEndChecker(def, model);
}
