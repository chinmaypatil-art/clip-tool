import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { writeFile } from "fs/promises";
import { createAnalysis, ensureAnalysisDir, listAnalyses, updateAnalysis } from "@/lib/analyses";
import { isUrl, isYoutubeUrl } from "@/lib/media";
import { runTranscriptExtraction, listProviderModels, makeClips } from "@/lib/analysisPipeline";
import { DEFAULT_CLIP_LENGTH, isClipLengthPreset } from "@/lib/clipLength";
import { parseCaptionStyle } from "@/lib/captionStyle";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  if (url.searchParams.get("providers") === "1") {
    return NextResponse.json({ providers: await listProviderModels() });
  }
  const analyses = (await listAnalyses()).filter((a) => !a.archived);
  // The history list doesn't need every transcript; the full analysis is one GET away.
  const summaries = analyses.map(({ transcript, runs, ...rest }) => ({
    ...rest,
    hasTranscript: Boolean(transcript),
    runs: runs.map((r) => ({ ...r, rawResponse: null })),
  }));
  return NextResponse.json({ analyses: summaries });
}

/**
 * Starts a new video. With `oneClick`, the server goes on to pick and render
 * clips by itself (see makeClips); otherwise it stops at the transcript and
 * Compare starts model runs.
 */
export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = await req.json().catch(() => null);
    const url = body?.url;
    if (typeof url !== "string" || !isUrl(url)) {
      return NextResponse.json({ error: "Provide a valid http(s) URL." }, { status: 400 });
    }
    const analysis = createAnalysis(url, isYoutubeUrl(url) ? "youtube" : "file", url);
    if (body?.oneClick) {
      applySettings(analysis.id, body);
      void makeClips(analysis.id, { kind: "url", url });
    } else {
      void runTranscriptExtraction(analysis.id, { kind: "url", url });
    }
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

    if (form.get("oneClick") === "1") {
      const settings = JSON.parse(String(form.get("settings") ?? "{}"));
      applySettings(analysis.id, settings);
      updateAnalysis(analysis.id, { title: file.name.replace(/\.[^.]+$/, "") });
      void makeClips(analysis.id, { kind: "file", path: uploadPath });
    } else {
      void runTranscriptExtraction(analysis.id, { kind: "file", path: uploadPath });
    }
    return NextResponse.json({ analysisId: analysis.id });
  }

  return NextResponse.json({ error: "Unsupported content type." }, { status: 400 });
}

function applySettings(id: string, body: { clipLength?: unknown; captions?: unknown; captionStyle?: unknown }) {
  updateAnalysis(id, {
    oneClick: true,
    clipLength: isClipLengthPreset(body.clipLength) ? body.clipLength : DEFAULT_CLIP_LENGTH,
    captionStyle: body.captions === false ? null : parseCaptionStyle(body.captionStyle),
  });
}
