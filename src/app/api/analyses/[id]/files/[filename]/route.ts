import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { stat } from "fs/promises";
import { createReadStream } from "fs";
import { Readable } from "stream";
import { loadAnalysis, analysisDir } from "@/lib/analyses";
import { segmentFilename } from "@/lib/analysisPipeline";

export async function GET(
  req: NextRequest,
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
      if (clip.renderFilename === filename || segmentFilename(run.id, clip.id) === filename) return true;
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
      "Content-Disposition": dispositionFor(req, filename),
    },
  });
}

/** ?download=<name> saves the file as "<name>.mp4" instead of playing it. */
function dispositionFor(req: NextRequest, filename: string): string {
  const name = new URL(req.url).searchParams.get("download");
  if (!name) return `inline; filename="${filename}"`;
  const safe = name.replace(/[^\w\s.-]/g, "").trim().slice(0, 80) || "clip";
  return `attachment; filename="${safe}.mp4"; filename*=UTF-8''${encodeURIComponent(name.slice(0, 80))}.mp4`;
}
