"use client";

import { useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Loader2, RotateCcw, ThumbsDown, ThumbsUp } from "lucide-react";
import { toSentences } from "@/lib/clipTrim";
import { REJECT_REASONS, isGoodReason, isRejectReason, type ClipReview, type ReviewReason } from "@/lib/review";
import type { TranscriptSegment } from "@/lib/transcript";

export interface ReviewableClip {
  id: string;
  startSeconds: number;
  endSeconds: number;
  modelStartSeconds?: number;
  modelEndSeconds?: number;
  renderStatus: "pending" | "rendering" | "done" | "error";
  renderedStartSeconds?: number;
  renderedEndSeconds?: number;
  review?: ClipReview;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

/**
 * Labels one clip for training: good/bad, why it's bad, and corrected edges.
 * Edges move a whole sentence at a time, so a correction can never cut a
 * sentence in half (the same rule the pipeline applies to model picks).
 */
export function ClipReviewPanel({
  analysisId,
  runId,
  clip,
  segments,
  canRender,
  onSaved,
  onRerender,
}: {
  analysisId: string;
  runId: string;
  clip: ReviewableClip;
  segments: TranscriptSegment[];
  canRender: boolean;
  onSaved: () => void;
  onRerender: () => void;
}) {
  const sentences = useMemo(() => toSentences(segments), [segments]);
  // The edges are tracked as sentence indexes, not times: caption lines
  // overlap, so turning a moved time back into a sentence could land on the
  // same sentence again and the arrow would seem to do nothing.
  const [initialStartIdx, initialEndIdx] = useMemo(() => {
    const si = Math.max(0, sentences.findIndex((s) => s.end > clip.startSeconds + 0.3));
    let ei = si;
    sentences.forEach((s, i) => {
      if (i >= si && s.start < clip.endSeconds - 0.3) ei = i;
    });
    return [si, ei];
  }, [sentences, clip.startSeconds, clip.endSeconds]);
  const [startIdx, setStartIdx] = useState(initialStartIdx);
  const [endIdx, setEndIdx] = useState(initialEndIdx);
  const [verdict, setVerdict] = useState<"good" | "bad" | null>(clip.review?.verdict ?? null);
  const [reasons, setReasons] = useState<ReviewReason[]>(clip.review?.reasons ?? []);
  const [note, setNote] = useState(clip.review?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const edgesChanged = startIdx !== initialStartIdx || endIdx !== initialEndIdx;
  // Small pads match snapToSentences, so the first/last word isn't clipped.
  const start = edgesChanged ? Math.max(0, Number(((sentences[startIdx]?.start ?? 0) - 0.3).toFixed(2))) : clip.startSeconds;
  const end = edgesChanged ? Number(((sentences[endIdx]?.end ?? 0) + 0.5).toFixed(2)) : clip.endSeconds;
  const firstLine = sentences[startIdx]?.text ?? "";
  const lastLine = sentences[endIdx]?.text ?? "";

  const moveStart = (dir: -1 | 1) => setStartIdx((i) => Math.min(endIdx, Math.max(0, i + dir)));
  const moveEnd = (dir: -1 | 1) => setEndIdx((i) => Math.min(sentences.length - 1, Math.max(startIdx, i + dir)));

  const renderedStart = clip.renderedStartSeconds ?? clip.modelStartSeconds ?? clip.startSeconds;
  const renderedEnd = clip.renderedEndSeconds ?? clip.modelEndSeconds ?? clip.endSeconds;
  const renderIsStale =
    clip.renderStatus === "done" &&
    (Math.abs(renderedStart - clip.startSeconds) > 0.05 || Math.abs(renderedEnd - clip.endSeconds) > 0.05);
  const reviewChanged =
    verdict !== (clip.review?.verdict ?? null) ||
    note !== (clip.review?.note ?? "") ||
    reasons.join() !== (clip.review?.reasons ?? []).join();

  /** Saves the verdict (if any) and/or new edges; with `rerender`, renders the clip again afterwards. */
  const save = async (rerender = false) => {
    if (!verdict && !edgesChanged) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/analyses/${analysisId}/runs/${runId}/clips/${clip.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(verdict ? { review: { verdict, reasons: reasons.filter(verdict === "bad" ? isRejectReason : isGoodReason), note } } : {}),
          ...(edgesChanged ? { startSeconds: start, endSeconds: end } : {}),
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Save failed.");
      onSaved();
      if (rerender) onRerender();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleReason = (r: ReviewReason) =>
    setReasons((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]));

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-white/5 bg-black/30 p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Review</span>
        {clip.review && !reviewChanged && !edgesChanged && (
          <span className="flex items-center gap-1 text-[10px] text-emerald-300">
            <Check size={10} /> saved
          </span>
        )}
      </div>

      {[
        { label: "Starts", time: start, line: firstLine, move: moveStart, fromStart: true },
        { label: "Ends", time: end, line: lastLine, move: moveEnd, fromStart: false },
      ].map((edge) => (
        <div key={edge.label} className="flex items-start gap-1.5">
          <button onClick={() => edge.move(-1)} className="rounded bg-white/5 p-0.5 text-zinc-400 hover:text-violet-300" title="One sentence earlier">
            <ChevronLeft size={12} />
          </button>
          <button onClick={() => edge.move(1)} className="rounded bg-white/5 p-0.5 text-zinc-400 hover:text-violet-300" title="One sentence later">
            <ChevronRight size={12} />
          </button>
          <p className="min-w-0 flex-1 text-[11px] leading-snug text-zinc-400">
            <span className="text-zinc-500">
              {edge.label} {formatTime(edge.time)}:
            </span>{" "}
            {edge.fromStart ? `"${edge.line.slice(0, 90)}${edge.line.length > 90 ? "…" : ""}"` : `"${edge.line.length > 90 ? "…" : ""}${edge.line.slice(-90)}"`}
          </p>
        </div>
      ))}
      {edgesChanged && (
        <button
          onClick={() => {
            setStartIdx(initialStartIdx);
            setEndIdx(initialEndIdx);
          }}
          className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300"
        >
          <RotateCcw size={10} /> undo edge changes ({(end - start).toFixed(1)}s)
        </button>
      )}

      <div className="flex gap-1.5">
        <button
          onClick={() => setVerdict("good")}
          className={`flex flex-1 items-center justify-center gap-1 rounded-md py-1 text-[11px] ${
            verdict === "good" ? "bg-emerald-600 text-white" : "bg-white/5 text-zinc-400 hover:text-emerald-300"
          }`}
        >
          <ThumbsUp size={11} /> Good
        </button>
        <button
          onClick={() => setVerdict("bad")}
          className={`flex flex-1 items-center justify-center gap-1 rounded-md py-1 text-[11px] ${
            verdict === "bad" ? "bg-red-600 text-white" : "bg-white/5 text-zinc-400 hover:text-red-300"
          }`}
        >
          <ThumbsDown size={11} /> Bad
        </button>
      </div>

      {verdict === "bad" && (
        <div className="flex flex-wrap gap-1">
          {(Object.keys(REJECT_REASONS) as (keyof typeof REJECT_REASONS)[]).map((r) => (
            <button
              key={r}
              onClick={() => toggleReason(r)}
              className={`rounded-full border px-2 py-0.5 text-[10px] ${
                reasons.includes(r) ? "border-red-400 bg-red-500/20 text-red-200" : "border-white/10 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {REJECT_REASONS[r]}
            </button>
          ))}
        </div>
      )}

      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        className="w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600"
      />

      <div className="flex gap-1.5">
        <button
          onClick={() => save()}
          disabled={saving || (!edgesChanged && (!verdict || !reviewChanged))}
          className="flex flex-1 items-center justify-center gap-1 rounded-md bg-violet-600 py-1 text-[11px] font-medium text-white disabled:opacity-40"
        >
          {saving && <Loader2 size={11} className="animate-spin" />} Save
        </button>
        {edgesChanged && canRender && (
          <button
            onClick={() => save(true)}
            disabled={saving}
            className="rounded-md bg-white/5 px-2 py-1 text-[11px] text-zinc-300 hover:bg-violet-600 hover:text-white disabled:opacity-40"
          >
            Save &amp; re-render
          </button>
        )}
        {!edgesChanged && renderIsStale && canRender && (
          <button onClick={onRerender} className="rounded-md bg-white/5 px-2 py-1 text-[11px] text-zinc-300 hover:bg-violet-600 hover:text-white">
            Re-render with new edges
          </button>
        )}
      </div>
      {error && <p className="text-[10px] text-red-300">{error}</p>}
    </div>
  );
}
