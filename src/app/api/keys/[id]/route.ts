import { NextRequest, NextResponse } from "next/server";
import { updateKey, deleteKey } from "@/lib/keystore";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const patch: { label?: string; enabled?: boolean } = {};
  if (typeof body?.label === "string") patch.label = body.label;
  if (typeof body?.enabled === "boolean") patch.enabled = body.enabled;

  try {
    const record = await updateKey(id, patch);
    return NextResponse.json({ key: record });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteKey(id);
  return NextResponse.json({ ok: true });
}
