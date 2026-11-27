"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Download, Film, Loader2, Search, Trash2 } from "lucide-react";
import type { Analysis } from "@/lib/analyses";
import type { Job } from "@/lib/jobs";
import { mainRun, videoTitle } from "./ProjectView";
import { clock, cn, when } from "./format";

type Summary = Omit<Analysis, "transcript">;

function isWorking(a: Summary): boolean {
  const run = mainRun(a);
  return a.status === "extracting_transcript" || run?.status === "running" || Boolean(run?.clips.some((c) => c.renderStatus === "rendering"));
}

function VideoCard({ a, onOpen, onDeleted }: { a: Summary; onOpen: () => void; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const run = mainRun(a);
  const clips = run?.clips ?? [];
  const thumb = clips.find((c) => c.renderThumbnailFilename)?.renderThumbnailFilename;
  const reviewed = clips.filter((c) => c.review).length;
  const working = isWorking(a);
  const failed = a.status === "error" || run?.status === "error";

  const remove = async () => {
    setDeleting(true);
    const res = await fetch(`/api/analyses/${a.id}`, { method: "DELETE" });
    setDeleting(false);
    setConfirming(false);
    if (res.ok) onDeleted();
  };

  return (
    <motion.div layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="group relative">
      <button onClick={onOpen} className="block w-full text-left">
        <div className="relative aspect-video overflow-hidden rounded-xl bg-white/[0.03] ring-1 ring-white/10 transition group-hover:ring-white/25">
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/analyses/${a.id}/files/${thumb}`} alt="" className="h-full w-full object-cover object-top opacity-90 transition group-hover:opacity-100" />
          ) : (
            <div className="flex h-full items-center justify-center text-zinc-700">
              <Film size={22} />
            </div>
          )}
          {working && (
            <span className="absolute left-2 top-2 flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] text-zinc-200 backdrop-blur">
              <Loader2 size={10} className="animate-spin" /> Working
            </span>
          )}
          {failed && <span className="absolute left-2 top-2 rounded-md bg-red-500/80 px-1.5 py-0.5 text-[10px] text-white">Failed</span>}
          {a.videoDurationSeconds && (
            <span className="absolute bottom-2 right-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-200">
              {clock(a.videoDurationSeconds)}
            </span>
          )}
        </div>
        <h3 className="mt-2.5 line-clamp-1 text-sm font-medium text-zinc-100">{videoTitle(a)}</h3>
        <p className="mt-0.5 text-xs text-zinc-500">
          {when(a.createdAt)} · {clips.length} clip{clips.length === 1 ? "" : "s"}
          {reviewed > 0 && ` · ${reviewed} reviewed`}
        </p>
      </button>
      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
        {confirming ? (
          <>
            <button onClick={remove} className="rounded-md bg-red-500 px-2 py-1 text-[11px] font-medium text-white">
              {deleting ? <Loader2 size={11} className="animate-spin" /> : "Delete"}
            </button>
            <button onClick={() => setConfirming(false)} className="rounded-md bg-black/70 px-2 py-1 text-[11px] text-zinc-200">
              Keep
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            disabled={working}
            className="rounded-md bg-black/70 p-1.5 text-zinc-300 backdrop-blur hover:text-red-400 disabled:hidden"
            title={reviewed ? "Delete the video and clips (your reviews are kept for training)" : "Delete the video and its clips"}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </motion.div>
  );
}

/** Clips made by the earlier New Clip flow (storage/jobs), kept viewable. */
function OlderJob({ job }: { job: Job }) {
  return (
    <div className="rounded-xl border border-white/10 p-4">
      <p className="truncate text-sm text-zinc-200">{job.sourceLabel}</p>
      <p className="mb-3 text-xs text-zinc-500">
        {when(job.createdAt)} · {job.clips?.length ?? 0} clips
      </p>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {(job.clips ?? []).map((c) => (
          <a
            key={c.id}
            href={`/api/jobs/${job.id}/clips/${c.filename}`}
            target="_blank"
            rel="noreferrer"
            className="group block"
            title={c.title}
          >
            <div className="aspect-[9/16] overflow-hidden rounded-lg bg-white/[0.03] ring-1 ring-white/10">
              {c.thumbnailFilename && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/jobs/${job.id}/clips/${c.thumbnailFilename}`} alt="" className="h-full w-full object-cover opacity-80 group-hover:opacity-100" />
              )}
            </div>
            <p className="mt-1 line-clamp-1 text-[11px] text-zinc-400">{c.title}</p>
            <p className="text-[10px] tabular-nums text-zinc-600">
              {clock(c.startSeconds)} – {clock(c.endSeconds)}
            </p>
          </a>
        ))}
      </div>
    </div>
  );
}

export function LibraryView({ onOpen }: { onOpen: (id: string) => void }) {
  const [videos, setVideos] = useState<Summary[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    const [a, j] = await Promise.all([
      fetch("/api/analyses").then((r) => (r.ok ? r.json() : { analyses: [] })),
      fetch("/api/jobs").then((r) => (r.ok ? r.json() : { jobs: [] })),
    ]);
    setVideos(a.analyses ?? []);
    setJobs((j.jobs ?? []).filter((job: Job) => job.status === "done" && job.clips?.length));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  const anyWorking = videos?.some(isWorking);
  useEffect(() => {
    if (!anyWorking) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [anyWorking, load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (videos ?? []).filter((a) => a.runs.length > 0 || a.oneClick);
    if (!q) return list;
    return list.filter(
      (a) => videoTitle(a).toLowerCase().includes(q) || mainRun(a)?.clips.some((c) => c.title.toLowerCase().includes(q))
    );
  }, [videos, query]);

  return (
    <div className="mx-auto max-w-6xl px-4 pb-24 pt-10">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">Library</h1>
          <p className="mt-1 text-xs text-zinc-500">Every video you&apos;ve made clips from.</p>
        </div>
        <label className="flex w-full items-center gap-2 rounded-xl glass px-3 sm:w-64">
          <Search size={14} className="text-zinc-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search videos and clips"
            className="w-full bg-transparent py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          />
        </label>
      </div>

      {videos === null ? (
        <div className="flex justify-center py-20">
          <Loader2 className="animate-spin text-zinc-600" />
        </div>
      ) : shown.length === 0 ? (
        <p className="py-20 text-center text-sm text-zinc-500">{query ? "Nothing matches." : "No videos yet."}</p>
      ) : (
        <div className="grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((a) => (
            <VideoCard key={a.id} a={a} onOpen={() => onOpen(a.id)} onDeleted={load} />
          ))}
        </div>
      )}

      {jobs.length > 0 && !query && (
        <div className="mt-16">
          <h2 className={cn("mb-4 flex items-center gap-2 text-sm font-medium text-zinc-400")}>
            <Download size={14} /> Earlier clips
          </h2>
          <div className="space-y-4">
            {jobs.map((job) => (
              <OlderJob key={job.id} job={job} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
