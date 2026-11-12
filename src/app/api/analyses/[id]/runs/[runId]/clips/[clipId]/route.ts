import { NextRequest, NextResponse } from "next/server";
import { loadAnalysis, updateRunClip, type AnalysisClip } from "@/lib/analyses";
import { isRejectReason, type ClipReview } from "@/lib/review";
import { exportTrainingData } from "@/lib/training";

/**
 * Saves a reviewer's verdict and/or corrected edges for one clip, then
 * rebuilds storage/training/ so the dataset always matches the reviews.
 * Body: { review?: {verdict, reasons, note} | null, startSeconds?, endSeconds? }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; runId: string; clipId: string }> }
) {
  const { id, runId, clipId } = await params;
  const analysis = await loadAnalysis(id);
  const clip = analysis?.runs.find((r) => r.id === runId)?.clips.find((c) => c.id === clipId);
  if (!analysis || !clip) return NextResponse.json({ error: "Clip not found." }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid body." }, { status: 400 });

  const patch: Partial<AnalysisClip> = {};

  if ("startSeconds" in body || "endSeconds" in body) {
    const start = Number(body.startSeconds ?? clip.startSeconds);
    const end = Number(body.endSeconds ?? clip.endSeconds);
    const duration = analysis.videoDurationSeconds ?? Infinity;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration || end - start < 3) {
      return NextResponse.json({ error: "Edges must be inside the video and at least 3 s apart." }, { status: 400 });
    }
    patch.startSeconds = start;
    patch.endSeconds = end;
    // Keep the model's own edges the first time they're corrected; training
    // compares them with the reviewer's.
    patch.modelStartSeconds = clip.modelStartSeconds ?? clip.startSeconds;
    patch.modelEndSeconds = clip.modelEndSeconds ?? clip.endSeconds;
  }

  if ("review" in body) {
    const r = body.review;
    if (r === null) {
      patch.review = undefined;
    } else if (r?.verdict === "good" || r?.verdict === "bad") {
      const review: ClipReview = {
        verdict: r.verdict,
        reasons: Array.isArray(r.reasons) ? r.reasons.filter(isRejectReason) : [],
        note: typeof r.note === "string" ? r.note.slice(0, 500) : "",
        reviewedAt: Date.now(),
      };
      patch.review = review;
    } else {
      return NextResponse.json({ error: "review.verdict must be 'good' or 'bad'." }, { status: 400 });
    }
  }

  updateRunClip(id, runId, clipId, patch);
  const training = await exportTrainingData();
  return NextResponse.json({ ok: true, training });
}
