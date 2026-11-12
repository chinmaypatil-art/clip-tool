import { NextRequest, NextResponse } from "next/server";
import { addCustomProvider, deleteCustomProvider } from "@/lib/keystore";
import { listAllProviders } from "@/lib/providers/registry";

/** Lists every provider (built-in + user-added) with its models. */
export async function GET() {
  return NextResponse.json({ providers: await listAllProviders() });
}

/** Adds an OpenAI-compatible provider: { label, baseUrl, models?: string[] | "a, b" } (models can be loaded later). */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl.trim() : "";
  const rawModels: unknown = body?.models;
  const models = (Array.isArray(rawModels) ? rawModels : typeof rawModels === "string" ? rawModels.split(",") : [])
    .map((m) => String(m).trim())
    .filter(Boolean);

  if (!label) return NextResponse.json({ error: "Provider name is required." }, { status: 400 });
  if (!/^https?:\/\//i.test(baseUrl)) {
    return NextResponse.json({ error: "Base URL must start with http:// or https://" }, { status: 400 });
  }

  try {
    const provider = await addCustomProvider(label, baseUrl, models);
    return NextResponse.json({ provider });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

/** Removes a user-added provider and its keys: DELETE /api/providers?id=... */
export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });
  await deleteCustomProvider(id);
  return NextResponse.json({ ok: true });
}
