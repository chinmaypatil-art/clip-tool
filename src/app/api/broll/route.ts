import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { randomUUID } from "crypto";
import { createWriteStream } from "fs";
import { rm, stat } from "fs/promises";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as NodeReadableStream } from "stream/web";
import { hasAccess } from "@/lib/access";
import { analysisDir, loadAnalysis } from "@/lib/analyses";
import { uploadFinished, uploadStarted } from "@/lib/activity";

const TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};
const MAX_BYTES = 1024 * 1024 * 1024;

/**
 * B-roll upload from the clip editor: the picture or video is the raw body,
 * its type in Content-Type, the video in ?analysisId=. Returns { file }.
 * Outside the proxy (it would cut bodies at 10 MB), so access is checked here.
 */
export async function POST(req: NextRequest) {
  // Counted as busy so the self-restart can't cut a long upload short.
  uploadStarted();
  try {
    return await saveBroll(req);
  } finally {
    uploadFinished();
  }
}

async function saveBroll(req: NextRequest) {
  if (!(await hasAccess(req))) return NextResponse.json({ error: "Log in first" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("analysisId") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(id) || !(await loadAnalysis(id))) return NextResponse.json({ error: "Analysis not found." }, { status: 404 });
  const ext = TYPES[(req.headers.get("content-type") ?? "").split(";")[0].trim()];
  if (!ext) return NextResponse.json({ error: "Use a PNG, JPG or WebP picture, or an MP4, MOV or WebM video." }, { status: 400 });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES || !req.body) {
    return NextResponse.json({ error: "That file is over 1 GB." }, { status: 400 });
  }
  const name = `broll-${randomUUID()}.${ext}`;
  const filePath = path.join(analysisDir(id), name);
  try {
    await pipeline(Readable.fromWeb(req.body as NodeReadableStream), createWriteStream(filePath));
    if ((await stat(filePath)).size === 0) throw new Error("empty");
  } catch {
    await rm(filePath, { force: true }).catch(() => {});
    return NextResponse.json({ error: "Upload failed. Try again." }, { status: 400 });
  }
  return NextResponse.json({ file: name });
}
