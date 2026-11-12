import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { getEligibleKeys, isLocalBaseUrl, listCustomProviders, setCustomProviderModels } from "@/lib/keystore";

// Not text-generation models; listing them as clip analysers would just fail.
const NON_CHAT = /whisper|tts|speech|audio|embed|guard|moderation|image|vision-preview|orpheus|playai|transcribe/i;

/**
 * Asks a custom provider which models this account can actually use (its
 * OpenAI-compatible GET /models) and saves that as the provider's model list.
 * Model ids get retired often; a hard-coded preset went stale and 404'd.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const def = (await listCustomProviders()).find((p) => p.id === id);
  if (!def) return NextResponse.json({ error: "Unknown provider." }, { status: 404 });

  const [key] = await getEligibleKeys(id);
  if (!key && !isLocalBaseUrl(def.baseUrl)) {
    return NextResponse.json({ error: `Add an API key for ${def.label} first.` }, { status: 400 });
  }

  try {
    const client = new OpenAI({ apiKey: key?.value ?? "local", baseURL: def.baseUrl });
    const ids: string[] = [];
    for await (const model of client.models.list()) ids.push(model.id);
    const models = ids.filter((m) => !NON_CHAT.test(m)).sort();
    if (models.length === 0) return NextResponse.json({ error: "The provider returned no text models." }, { status: 502 });
    const provider = await setCustomProviderModels(id, models);
    return NextResponse.json({ provider });
  } catch (err) {
    return NextResponse.json(
      { error: `Couldn't load models from ${def.label}: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }
}
