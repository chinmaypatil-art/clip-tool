import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { writeFile } from "fs/promises";
import { createAnalysis, ensureAnalysisDir, listAnalyses } from "@/lib/analyses";
import { isUrl, isYoutubeUrl } from "@/lib/media";
import { runTranscriptExtraction, listProviderModels } from "@/lib/analysisPipeline";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  if (url.searchParams.get("providers") === "1") {
    return NextResponse.json({ providers: await listProviderModels() });
  }
  const analyses = (await listAnalyses()).filter((a) => !a.archived);
  return NextResponse.json({ analyses });
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = await req.json().catch(() => null);
    const url = body?.url;
    if (typeof url !== "string" || !isUrl(url)) {
      return NextResponse.json({ error: "Provide a valid http(s) URL." }, { status: 400 });
    }
    const analysis = createAnalysis(url, isYoutubeUrl(url) ? "youtube" : "file", url);
    void runTranscriptExtraction(analysis.id, { kind: "url", url });
    return NextResponse.json({ analysisId: analysis.id });
  }

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }
    const maxBytes = 2 * 1024 * 1024 * 1024;
    if (file.size === 0 || file.size > maxBytes) {
      return NextResponse.json({ error: "File must be non-empty and under 2GB." }, { status: 400 });
    }

    const analysis = createAnalysis(file.name, "file");
    const dir = await ensureAnalysisDir(analysis.id);
    const uploadPath = path.join(dir, "upload-raw");
    await writeFile(uploadPath, Buffer.from(await file.arrayBuffer()));

    void runTranscriptExtraction(analysis.id, { kind: "file", path: uploadPath });
    return NextResponse.json({ analysisId: analysis.id });
  }

  return NextResponse.json({ error: "Unsupported content type." }, { status: 400 });
}
