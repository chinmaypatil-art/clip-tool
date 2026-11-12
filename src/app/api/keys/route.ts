import { NextRequest, NextResponse } from "next/server";
import { listKeys, addKey } from "@/lib/keystore";
import { getProvider } from "@/lib/providers/registry";

export async function GET() {
  const keys = await listKeys();
  return NextResponse.json({ keys });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const provider = body?.provider;
  const label = body?.label;
  const key = body?.key;

  if (typeof provider !== "string" || !(await getProvider(provider))) {
    return NextResponse.json({ error: "Unknown provider. Add it under Custom providers first." }, { status: 400 });
  }
  if (typeof key !== "string" || !key.trim()) {
    return NextResponse.json({ error: "API key value is required." }, { status: 400 });
  }

  try {
    const record = await addKey(provider, typeof label === "string" ? label : "", key);
    return NextResponse.json({ key: record });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
