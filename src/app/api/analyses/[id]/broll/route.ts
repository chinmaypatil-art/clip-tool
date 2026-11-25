import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { randomUUID } from "crypto";
import { writeFile } from "fs/promises";
import { analysisDir, loadAnalysis } from "@/lib/analyses";

const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
// Under the proxy's 10 MB body limit (it would silently cut a bigger upload).
const MAX_BYTES = 9 * 1024 * 1024;

/** B-roll upload from the clip editor: form field "file" (PNG, JPG or WebP, up to 9 MB). Returns { file }. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await loadAnalysis(id))) return NextResponse.json({ error: "Analysis not found." }, { status: 404 });
  const file = (await req.formData().catch(() => null))?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose an image." }, { status: 400 });
  const ext = TYPES[file.type];
  if (!ext) return NextResponse.json({ error: "Use a PNG, JPG or WebP image." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "That image is over 9 MB." }, { status: 400 });
  const name = `broll-${randomUUID()}.${ext}`;
  await writeFile(path.join(analysisDir(id), name), Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({ file: name });
}
