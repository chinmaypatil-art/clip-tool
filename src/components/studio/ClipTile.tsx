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
      className="group flex h-full flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-b from-white/[0.035] to-white/[0.01] shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset] transition hover:border-white/[0.16] hover:shadow-[0_12px_40px_-12px_rgba(0,0,0,0.8)]"
    >
      <div className="relative aspect-[9/16] overflow-hidden bg-black">
        {clip.renderStatus === "done" && fileUrl ? (
          <video src={fileUrl} poster={thumbUrl} controls preload="none" className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
            {busy ? (
              <>
                <Loader2 size={20} className="animate-spin text-zinc-400" />
                <span className="text-xs text-zinc-500">{clip.renderStartedAt ? "Rendering…" : clip.queueAhead ? `In line · ${clip.queueAhead} ahead` : "Waiting…"}</span>
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
        <div className="pointer-events-none absolute left-2 top-2 flex gap-1">
          <span className="rounded-md bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-zinc-900">#{index + 1}</span>
          <span className="rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white ring-1 ring-white/10 backdrop-blur">
            {clock(length)}
          </span>
          {clip.edit && <span className="rounded-md bg-sky-500/80 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">Edited</span>}
        </div>
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

      <div className="flex min-w-0 flex-1 flex-col p-3.5">
        <h3 className="line-clamp-2 min-h-[2.5rem] text-[13px] font-semibold leading-5 tracking-tight text-zinc-50" title={clip.title}>
          {clip.title}
        </h3>
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
        {clip.hook && (
          <p className="mt-2.5 line-clamp-2 border-l-2 border-amber-400/60 pl-2 text-[11px] italic leading-4 text-zinc-400" title="Opens with this line">
            &ldquo;{clip.hook}&rdquo;
          </p>
        )}
        {clip.reasoning && (
          <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-zinc-500" title={clip.reasoning}>
            {clip.reasoning}
          </p>
        )}

        <div className="mt-auto flex gap-1.5 pt-3.5">
          {canRender && (
            <button
              onClick={() => setEditing(true)}
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-white text-xs font-semibold text-zinc-900 shadow-sm transition hover:bg-zinc-200 active:scale-[0.98]"
            >
              <Pencil size={13} /> Edit clip
            </button>
          )}
          {fileUrl && clip.renderStatus === "done" && (
            <a
              href={`${fileUrl}?download=${encodeURIComponent(clip.title)}`}
              title="Download"
              aria-label="Download"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-zinc-300 transition hover:bg-white/[0.1] hover:text-white"
            >
              <Download size={14} />
            </a>
          )}
          <button
            onClick={() => setReviewing((r) => !r)}
            title="Move the start or end by a sentence"
            aria-label="Fix start/end"
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-lg border transition",
              reviewing ? "border-white bg-white text-zinc-900" : "border-white/[0.08] bg-white/[0.04] text-zinc-300 hover:bg-white/[0.1] hover:text-white"
            )}
          >
            <Scissors size={14} />
          </button>
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
