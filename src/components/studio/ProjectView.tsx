"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Check, ExternalLink, Loader2, AlertCircle } from "lucide-react";
import type { Analysis, ModelRun } from "@/lib/analyses";
import { CLIP_LENGTH_PRESETS } from "@/lib/clipLength";
import { ClipTile } from "./ClipTile";
import { clock, cn, when } from "./format";

/** The run whose clips we show: the local model's latest finished run, else the latest run. */
export function mainRun(analysis: Pick<Analysis, "runs">): ModelRun | undefined {
  const runs = [...analysis.runs].reverse();
  return (
    runs.find((r) => r.provider === "ollama-local" && r.status === "done") ??
    runs.find((r) => r.status === "done") ??
    runs.find((r) => r.status === "running") ??
    runs[0]
  );
}

export function videoTitle(a: Pick<Analysis, "title" | "sourceLabel">): string {
  return a.title || a.sourceLabel.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60);
}

const STEPS = ["Downloading", "Reading transcript", "Finding the best moments", "Making clips"] as const;

/** Which step the video is on (0-3), 4 when finished, or "error". */
function stepOf(a: Analysis, run: ModelRun | undefined): number | "error" {
  if (a.status === "error" || run?.status === "error") return "error";
  if (a.status === "extracting_transcript") return a.downloadedAt ? 1 : 0;
  if (!run || run.status === "running" || run.status === "queued") return a.oneClick ? 2 : 4;
  if (run.clips.some((c) => c.renderStatus === "rendering")) return 3;
  return 4;
}

export function ProjectView({ id, onBack }: { id: string; onBack: () => void }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/analyses/${id}`);
    if (res.status === 404) return setMissing(true);
    if (res.ok) setAnalysis(await res.json());
  }, [id]);

  const run = analysis ? mainRun(analysis) : undefined;
  const step = analysis ? stepOf(analysis, run) : 0;
  const active = step !== 4 && step !== "error";

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      setNow(Date.now());
      void load();
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, [active, load]);

  if (missing) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-20 text-center text-sm text-zinc-500">
        This video was deleted.{" "}
        <button onClick={onBack} className="text-zinc-300 underline">
          Back
        </button>
      </div>
    );
  }
  if (!analysis) {
    return (
      <div className="flex justify-center py-32">
        <Loader2 className="animate-spin text-zinc-600" />
      </div>
    );
  }

  const clips = run?.clips ?? [];
  const done = clips.filter((c) => c.renderStatus === "done").length;
  const minSeconds = run?.clipLength ? CLIP_LENGTH_PRESETS[run.clipLength].minSeconds : undefined;
  const finishedAt = Math.max(0, ...clips.map((c) => c.renderFinishedAt ?? 0)) || analysis.updatedAt;
  const elapsed = Math.round(((active ? now : finishedAt) - analysis.createdAt) / 1000);

  return (
    <div className="mx-auto max-w-6xl px-4 pb-24 pt-8">
      <button onClick={onBack} className="mb-6 flex items-center gap-1.5 text-xs text-zinc-500 transition hover:text-zinc-200">
        <ArrowLeft size={14} /> Back
      </button>

      <div className="mb-8 flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">{videoTitle(analysis)}</h1>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
          <span>{when(analysis.createdAt)}</span>
          {analysis.videoDurationSeconds && <span>· {clock(analysis.videoDurationSeconds)} video</span>}
          {run?.clipLength && <span>· {CLIP_LENGTH_PRESETS[run.clipLength].label} clips</span>}
          {analysis.captionStyle === null && <span>· no captions</span>}
          {analysis.sourceUrl && (
            <a href={analysis.sourceUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-zinc-300">
              · Source <ExternalLink size={10} />
            </a>
          )}
          {!active && step !== "error" && analysis.oneClick && <span>· made in {clock(elapsed)}</span>}
        </div>
      </div>

      {step === "error" && (
        <div className="mb-8 flex items-start gap-3 rounded-2xl border border-red-500/20 bg-red-500/[0.06] p-4 text-sm text-red-300">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{analysis.error ?? run?.error ?? "Something went wrong."}</span>
        </div>
      )}

      {active && (
        <div className="mb-10 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <div className="grid gap-3 sm:grid-cols-4">
            {STEPS.map((label, i) => {
              const state = typeof step === "number" ? (i < step ? "done" : i === step ? "now" : "todo") : "todo";
              return (
                <div key={label} className="flex items-center gap-2.5">
                  <span
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px]",
                      state === "done" && "bg-white text-zinc-900",
                      state === "now" && "bg-white/10 text-white",
                      state === "todo" && "bg-white/[0.04] text-zinc-600"
                    )}
                  >
                    {state === "done" ? <Check size={12} /> : state === "now" ? <Loader2 size={12} className="animate-spin" /> : i + 1}
                  </span>
                  <span className={cn("text-xs", state === "todo" ? "text-zinc-600" : "text-zinc-300")}>
                    {label}
                    {i === 3 && state === "now" && clips.length > 0 && ` ${done}/${clips.length}`}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="mt-4 h-1 overflow-hidden rounded-full bg-white/[0.05]">
            <motion.div
              className="h-full rounded-full bg-white/70"
              animate={{ width: `${((typeof step === "number" ? step : 0) + (step === 3 && clips.length ? done / clips.length : 0.4)) * 25}%` }}
              transition={{ ease: "easeOut", duration: 0.6 }}
            />
          </div>
          <p className="mt-3 text-[11px] tabular-nums text-zinc-600">{clock(elapsed)} so far · usually 8–10 min. You can leave this page; it keeps going.</p>
        </div>
      )}

      {run && clips.length > 0 && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-5">
          {clips.map((clip, i) => (
            <ClipTile
              key={clip.id}
              analysisId={analysis.id}
              runId={run.id}
              clip={clip}
              index={i}
              sourceUrl={analysis.sourceUrl}
              segments={analysis.transcript?.segments ?? []}
              canRender={!analysis.sourceDeleted}
              shortOf={minSeconds}
              onChanged={load}
            />
          ))}
        </div>
      )}
      {run?.status === "done" && clips.length === 0 && (
        <p className="py-16 text-center text-sm text-zinc-500">No clips found in this video.</p>
      )}
    </div>
  );
}
