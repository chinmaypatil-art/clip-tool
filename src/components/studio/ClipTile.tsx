"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { AlertCircle, Download, ExternalLink, Loader2, Pencil, RotateCw, Scissors, ThumbsDown, ThumbsUp } from "lucide-react";
import type { AnalysisClip } from "@/lib/analyses";
import type { TranscriptSegment } from "@/lib/transcript";
import { ClipReviewPanel } from "@/components/ClipReviewPanel";
import { QuickFeedback } from "./QuickFeedback";
import { ClipEditor } from "./ClipEditor";
import { clock, cn, linkAt } from "./format";

export function ClipTile({
  analysisId,
  runId,
  clip,
  index,
  sourceUrl,
  segments,
  canRender,
  shortOf,
  onChanged,
}: {
  analysisId: string;
  runId: string;
  clip: AnalysisClip;
  index: number;
  sourceUrl?: string;
  segments: TranscriptSegment[];
  canRender: boolean;
  /** The chosen minimum length, to flag clips that came out shorter. */
  shortOf?: number;
  onChanged: () => void;
}) {
  const [reviewing, setReviewing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [starting, setStarting] = useState(false);
  const length = clip.endSeconds - clip.startSeconds;
  const fileUrl = clip.renderFilename ? `/api/analyses/${analysisId}/files/${clip.renderFilename}` : null;
  const thumbUrl = clip.renderThumbnailFilename ? `/api/analyses/${analysisId}/files/${clip.renderThumbnailFilename}` : undefined;
  const sourceLink = linkAt(sourceUrl, clip.startSeconds);
  const busy = clip.renderStatus === "rendering" || starting;

  const render = async () => {
    setStarting(true);
    try {
      await fetch(`/api/analyses/${analysisId}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets: [{ runId, clipId: clip.id }] }),
      });
      onChanged();
    } finally {
      setStarting(false);
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04 }}
      className="flex flex-col"
    >
      <div className="relative aspect-[9/16] overflow-hidden rounded-2xl bg-white/[0.03] ring-1 ring-white/10">
        {clip.renderStatus === "done" && fileUrl ? (
          <video src={fileUrl} poster={thumbUrl} controls preload="none" className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
            {busy ? (
              <>
                <Loader2 size={20} className="animate-spin text-zinc-400" />
                <span className="text-xs text-zinc-500">{clip.renderStartedAt ? "Rendering…" : "Waiting…"}</span>
              </>
            ) : clip.renderStatus === "error" ? (
              <>
                <AlertCircle size={20} className="text-red-400" />
                <span className="line-clamp-3 text-xs text-zinc-500">{clip.renderError ?? "Render failed"}</span>
                {canRender && (
                  <button onClick={render} className="flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/20">
                    <RotateCw size={12} /> Try again
                  </button>
                )}
              </>
            ) : canRender ? (
              <button onClick={render} className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-zinc-200">
                Render clip
              </button>
            ) : (
              <span className="text-xs text-zinc-600">Not rendered</span>
            )}
          </div>
        )}
        <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white backdrop-blur">
          {clock(length)}
        </span>
        {clip.review && (
          <span
            className={cn(
              "pointer-events-none absolute right-2 top-2 rounded-md p-1 backdrop-blur",
              clip.review.verdict === "good" ? "bg-emerald-500/80 text-white" : "bg-red-500/80 text-white"
            )}
          >
            {clip.review.verdict === "good" ? <ThumbsUp size={11} /> : <ThumbsDown size={11} />}
          </span>
        )}
      </div>

      <div className="mt-3 flex min-w-0 flex-1 flex-col px-0.5">
        <h3 className="line-clamp-2 text-sm font-medium leading-snug text-zinc-100">{clip.title}</h3>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs tabular-nums text-zinc-500">
          {sourceLink ? (
            <a href={sourceLink} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-zinc-300" title="Open the source here">
              {clock(clip.startSeconds)} – {clock(clip.endSeconds)} <ExternalLink size={10} />
            </a>
          ) : (
            <span>
              {clock(clip.startSeconds)} – {clock(clip.endSeconds)}
            </span>
          )}
          {shortOf !== undefined && length < shortOf - 1 && <span className="text-amber-400/80">· shorter than asked</span>}
        </div>
        {clip.hook && <p className="mt-1.5 line-clamp-2 text-xs italic text-zinc-500">&ldquo;{clip.hook}&rdquo;</p>}
        {clip.reasoning && (
          <p className="mt-1 line-clamp-3 text-xs text-zinc-400">
            <span className="text-zinc-500">Why: </span>
            {clip.reasoning}
          </p>
        )}

        <div className="mt-3 flex gap-1.5">
          {fileUrl && clip.renderStatus === "done" && (
            <a
              href={`${fileUrl}?download=${encodeURIComponent(clip.title)}`}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-white/[0.06] py-1.5 text-xs text-zinc-200 transition hover:bg-white/[0.12]"
            >
              <Download size={13} /> Download
            </a>
          )}
          <button
            onClick={() => setReviewing((r) => !r)}
            title="Move the start or end by a sentence"
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs transition",
              reviewing ? "bg-white text-zinc-900" : "bg-white/[0.06] text-zinc-200 hover:bg-white/[0.12]"
            )}
          >
            <Scissors size={13} /> Fix start/end
          </button>
          {canRender && (
            <button
              onClick={() => setEditing(true)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-white/[0.06] py-1.5 text-xs text-zinc-200 transition hover:bg-white/[0.12]"
            >
              <Pencil size={13} /> Edit
            </button>
          )}
        </div>
        <QuickFeedback
          key={clip.review?.reviewedAt ?? "new"}
          url={`/api/analyses/${analysisId}/runs/${runId}/clips/${clip.id}`}
          review={clip.review}
          onSaved={onChanged}
        />
        {editing && <ClipEditor analysisId={analysisId} runId={runId} clip={clip} onClose={() => setEditing(false)} onSaved={onChanged} />}
        {reviewing && (
          <ClipReviewPanel
            analysisId={analysisId}
            runId={runId}
            clip={clip}
            segments={segments}
            canRender={canRender}
            onSaved={onChanged}
            onRerender={render}
          />
        )}
      </div>
    </motion.div>
  );
}
