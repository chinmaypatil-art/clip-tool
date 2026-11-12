import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { stat } from "fs/promises";
import { createReadStream } from "fs";
import { Readable } from "stream";
import { loadJob, jobDir } from "@/lib/jobs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; filename: string }> }
) {
  const { id, filename } = await params;
  const job = await loadJob(id);
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });

  // filename must match either a clip's video file or its thumbnail, both
  // recorded on the job itself — this is what makes it safe against path
  // traversal regardless of what's in the URL segment, not the filename string itself.
  const clip = job.clips?.find((c) => c.filename === filename || c.thumbnailFilename === filename);
  if (!clip) return NextResponse.json({ error: "Clip not found." }, { status: 404 });

  const isThumbnail = clip.thumbnailFilename === filename;
  const filePath = path.join(jobDir(id), filename);
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
