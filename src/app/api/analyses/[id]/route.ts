import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { readdir, rm } from "fs/promises";
import { loadAnalysis, analysisDir, forgetAnalysis, updateAnalysis } from "@/lib/analyses";
import { forgetRenderBundle } from "@/lib/analysisPipeline";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const analysis = await loadAnalysis(id);
  if (!analysis) return NextResponse.json({ error: "Analysis not found." }, { status: 404 });
  return NextResponse.json(analysis);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const analysis = await loadAnalysis(id);
  // Reviews are training data: a reviewed video leaves history and loses its
  // media, but analysis.json (transcript, picks, reviews) stays for training.
  if (analysis?.runs.some((r) => r.clips.some((c) => c.review))) {
    if (analysis.runs.some((r) => r.clips.some((c) => c.renderStatus === "rendering"))) {
      return NextResponse.json({ error: "Wait for renders to finish." }, { status: 409 });
    }
    const dir = analysisDir(id);
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (f !== "analysis.json") await rm(path.join(dir, f), { recursive: true, force: true });
    }
    await forgetRenderBundle(id);
    updateAnalysis(id, { archived: true, sourceDeleted: true });
    return NextResponse.json({ ok: true, archived: true });
  }
  forgetAnalysis(id);
  await rm(analysisDir(id), { recursive: true, force: true }).catch(() => {});
  return NextResponse.json({ ok: true });
}
