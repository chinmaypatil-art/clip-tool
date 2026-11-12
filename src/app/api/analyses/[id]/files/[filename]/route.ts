import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { stat } from "fs/promises";
import { createReadStream } from "fs";
import { Readable } from "stream";
import { loadAnalysis, analysisDir } from "@/lib/analyses";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; filename: string }> }
) {
  const { id, filename } = await params;
  const analysis = await loadAnalysis(id);
  if (!analysis) return NextResponse.json({ error: "Analysis not found." }, { status: 404 });

  // filename must match a recorded render output or thumbnail on one of this
  // analysis's own runs — this (not the filename string itself) is what
  // makes the lookup safe against path traversal.
  let isThumbnail = false;
  const match = analysis.runs.some((run) =>
    run.clips.some((clip) => {
      if (clip.renderFilename === filename) return true;
      if (clip.renderThumbnailFilename === filename) {
        isThumbnail = true;
        return true;
      }
      return false;
    })
  );
  if (!match) return NextResponse.json({ error: "File not found." }, { status: 404 });

  const filePath = path.join(analysisDir(id), filename);
  const stats = await stat(filePath).catch(() => null);
  if (!stats) return NextResponse.json({ error: "File missing on disk." }, { status: 404 });

  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": isThumbnail ? "image/jpeg" : "video/mp4",
      "Content-Length": String(stats.size),
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  });
}
