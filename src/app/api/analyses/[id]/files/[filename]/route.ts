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
  // The editor previews edits by playing the source itself.
  const match = (filename === "source.mp4" && !analysis.sourceDeleted) || analysis.runs.some((run) =>
    run.clips.some((clip) => {
      if (clip.renderFilename === filename || clip.wordsFilename === filename || segmentFilename(run.id, clip.id) === filename) return true;
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

  const headers = {
    "Content-Type": isThumbnail ? "image/jpeg" : filename.endsWith(".json") ? "application/json" : "video/mp4",
    "Content-Disposition": dispositionFor(req, filename),
    "Accept-Ranges": "bytes",
  };
  // Players seek by asking for a byte range; without 206 replies the
  // timeline can't be dragged and the video just keeps playing.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    const size = stats.size;
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
    return new NextResponse(stream, {
      status: 206,
      headers: { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}` },
    });
  }
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new NextResponse(stream, { headers: { ...headers, "Content-Length": String(stats.size) } });
}

/** ?download=<name> saves the file as "<name>.mp4" instead of playing it. */
function dispositionFor(req: NextRequest, filename: string): string {
  const name = new URL(req.url).searchParams.get("download");
  if (!name) return `inline; filename="${filename}"`;
  const safe = name.replace(/[^\w\s.-]/g, "").trim().slice(0, 80) || "clip";
  return `attachment; filename="${safe}.mp4"; filename*=UTF-8''${encodeURIComponent(name.slice(0, 80))}.mp4`;
}
