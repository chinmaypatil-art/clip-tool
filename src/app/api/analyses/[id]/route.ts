import { NextRequest, NextResponse } from "next/server";
import { rm } from "fs/promises";
import { loadAnalysis, analysisDir, forgetAnalysis } from "@/lib/analyses";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const analysis = await loadAnalysis(id);
  if (!analysis) return NextResponse.json({ error: "Analysis not found." }, { status: 404 });
  return NextResponse.json(analysis);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  forgetAnalysis(id);
  await rm(analysisDir(id), { recursive: true, force: true }).catch(() => {});
  return NextResponse.json({ ok: true });
}
