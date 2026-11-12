import { NextRequest, NextResponse } from "next/server";
import { loadAnalysis } from "@/lib/analyses";
import { renderAnalysisClip } from "@/lib/analysisPipeline";

/** Renders one or more clips (by runId+clipId) from this analysis's model results. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const analysis = await loadAnalysis(id);
  if (!analysis) return NextResponse.json({ error: "Analysis not found." }, { status: 404 });

  const body = await req.json().catch(() => null);
  const targets = body?.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    return NextResponse.json({ error: "Provide `targets`: [{runId, clipId}, ...]." }, { status: 400 });
  }

  if (analysis.sourceDeleted) {
    return NextResponse.json({ error: "The source video was deleted to free space." }, { status: 409 });
  }
  for (const t of targets) {
    if (typeof t?.runId !== "string" || typeof t?.clipId !== "string") {
      return NextResponse.json({ error: "Each target needs runId and clipId." }, { status: 400 });
    }
    const clip = analysis.runs.find((r) => r.id === t.runId)?.clips.find((c) => c.id === t.clipId);
    if (clip?.renderStatus === "rendering") {
      return NextResponse.json({ error: "That clip is already rendering." }, { status: 409 });
    }
  }

  // Renders are CPU/time-heavy (minutes each on this hardware) — run them one
  // at a time rather than flooding concurrent Remotion/Chrome processes,
  // which is what caused real render failures under load earlier.
  (async () => {
    for (const t of targets) {
      await renderAnalysisClip(id, t.runId, t.clipId);
    }
  })();

  return NextResponse.json({ ok: true, queued: targets.length });
}
