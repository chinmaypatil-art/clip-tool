import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { readdir, rm } from "fs/promises";
import { loadAnalysis, analysisDir, updateAnalysis, updateRunClip } from "@/lib/analyses";
import { forgetRenderBundle } from "@/lib/analysisPipeline";

/**
 * Frees disk space once a video has been reviewed: deletes the downloaded
 * source video and the clips' audio files, and (with `renders: true`) the
 * rendered MP4s. analysis.json, which holds the transcript, picks and
 * reviews, is always kept; it is the training data.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const analysis = await loadAnalysis(id);
  if (!analysis) return NextResponse.json({ error: "Analysis not found." }, { status: 404 });

  const clips = analysis.runs.flatMap((r) => r.clips);
  if (clips.some((c) => c.renderStatus === "rendering")) {
    return NextResponse.json({ error: "Wait for renders to finish." }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const deleteRenders = body?.renders === true;
  const dir = analysisDir(id);
  const files = await readdir(dir).catch(() => [] as string[]);
  const doomed = files.filter(
    (f) => f === "source.mp4" || f.endsWith(".wav") || (deleteRenders && f.startsWith("render-") && f.endsWith(".mp4"))
  );
  for (const f of doomed) await rm(path.join(dir, f), { force: true });
  await forgetRenderBundle(id);

  if (deleteRenders) {
    for (const run of analysis.runs) {
      for (const clip of run.clips) {
        if (clip.renderFilename) updateRunClip(id, run.id, clip.id, { renderStatus: "pending", renderFilename: undefined });
      }
    }
  }
  updateAnalysis(id, { sourceDeleted: true });
  return NextResponse.json({ ok: true, deleted: doomed.length });
}
