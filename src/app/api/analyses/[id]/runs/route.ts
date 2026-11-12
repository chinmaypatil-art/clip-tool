import { NextRequest, NextResponse } from "next/server";
import { loadAnalysis } from "@/lib/analyses";
import { runModelAgainstAnalysis } from "@/lib/analysisPipeline";
import { getProvider } from "@/lib/providers/registry";
import { DEFAULT_CLIP_LENGTH, isClipLengthPreset } from "@/lib/clipLength";

/** Starts one or more model runs against this analysis's existing transcript — never re-extracts it. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const analysis = await loadAnalysis(id);
  if (!analysis) return NextResponse.json({ error: "Analysis not found (or not yet loaded into memory)." }, { status: 404 });
  if (analysis.status !== "ready") {
    return NextResponse.json({ error: `Analysis is not ready yet (status: ${analysis.status}).` }, { status: 409 });
  }

  const body = await req.json().catch(() => null);
  const requests = body?.models;
  if (!Array.isArray(requests) || requests.length === 0) {
    return NextResponse.json({ error: "Provide `models`: [{provider, model}, ...]." }, { status: 400 });
  }

  for (const r of requests) {
    if (typeof r?.provider !== "string" || !(await getProvider(r.provider)) || typeof r?.model !== "string") {
      return NextResponse.json({ error: "Each entry needs a valid provider and model." }, { status: 400 });
    }
  }

  // Fire all requested runs concurrently (capped by the small number a user
  // would realistically select at once) — each is independent and tracked
  // via its own ModelRun record.
  const clipLength = isClipLengthPreset(body?.clipLength) ? body.clipLength : DEFAULT_CLIP_LENGTH;
  for (const r of requests) {
    void runModelAgainstAnalysis(id, r.provider, r.model, clipLength);
  }

  return NextResponse.json({ ok: true, started: requests.length });
}
