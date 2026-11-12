import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { writeFile } from "fs/promises";
import { createJob, ensureJobDir, listJobs } from "@/lib/jobs";
import { isUrl } from "@/lib/media";
import { runPipeline } from "@/lib/pipeline";
import { DEFAULT_CLIP_LENGTH, isClipLengthPreset } from "@/lib/clipLength";

/** Lists all jobs (current + past), newest first — backs the library/history view. */
export async function GET() {
  const jobs = await listJobs();
  return NextResponse.json({ jobs });
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = await req.json().catch(() => null);
    const url = body?.url;
    if (typeof url !== "string" || !isUrl(url)) {
      return NextResponse.json({ error: "Provide a valid http(s) URL." }, { status: 400 });
    }

    const clipLength = isClipLengthPreset(body?.clipLength) ? body.clipLength : DEFAULT_CLIP_LENGTH;
    const job = createJob(url, clipLength);
    void runPipeline({ jobId: job.id, source: { kind: "url", url }, clipLength });
    return NextResponse.json({ jobId: job.id });
  }

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: "Uploaded file is empty." }, { status: 400 });
    }
    const maxBytes = 2 * 1024 * 1024 * 1024; // 2GB, matches Gemini free-tier Files API cap
    if (file.size > maxBytes) {
      return NextResponse.json({ error: "File exceeds 2GB limit." }, { status: 400 });
    }

    const lengthField = form.get("clipLength");
    const clipLength = isClipLengthPreset(lengthField) ? lengthField : DEFAULT_CLIP_LENGTH;
    const job = createJob(file.name, clipLength);
    const dir = await ensureJobDir(job.id);
    const uploadPath = path.join(dir, "upload-raw");
    const bytes = Buffer.from(await file.arrayBuffer());
    await writeFile(uploadPath, bytes);

    void runPipeline({ jobId: job.id, source: { kind: "file", path: uploadPath }, clipLength });
    return NextResponse.json({ jobId: job.id });
  }

  return NextResponse.json({ error: "Unsupported content type." }, { status: 400 });
}
