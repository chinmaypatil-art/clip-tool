import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { existsSync } from "fs";
import { loadAnalysis, analysisDir, updateAnalysis } from "@/lib/analyses";
import { makeClips } from "@/lib/analysisPipeline";
import { probeVideo } from "@/lib/media";

/** Starts a failed upload over from the file already on disk, so a big video needn't be sent again. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const analysis = await loadAnalysis(id);
  if (!analysis) return NextResponse.json({ error: "Analysis not found." }, { status: 404 });
  if (analysis.status !== "error") return NextResponse.json({ error: "This video isn't stopped." }, { status: 409 });
  const uploadPath = path.join(analysisDir(id), "upload-raw");
  if (!existsSync(uploadPath) || !(await probeVideo(uploadPath).then(() => true, () => false))) {
    return NextResponse.json({ error: "The uploaded file isn't a playable video. Upload it again." }, { status: 400 });
  }
  updateAnalysis(id, { status: "extracting_transcript", error: null, oneClick: true });
  void makeClips(id, { kind: "file", path: uploadPath });
  return NextResponse.json({ ok: true });
}
