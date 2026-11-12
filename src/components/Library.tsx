"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Trash2, ChevronDown, ChevronRight, Loader2, AlertTriangle } from "lucide-react";
import type { Job } from "@/lib/jobs";
import ClipCard from "./ClipCard";

function statusLabel(status: Job["status"]): string {
  switch (status) {
    case "done":
      return "Done";
    case "error":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Processing…";
  }
}

function statusColor(status: Job["status"]): string {
  switch (status) {
    case "done":
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    case "error":
      return "bg-red-500/15 text-red-300 border-red-500/30";
    case "cancelled":
      return "bg-white/10 text-zinc-400 border-white/15";
    default:
      return "bg-violet-500/15 text-violet-300 border-violet-500/30";
  }
}

export default function Library({ refreshKey }: { refreshKey: number }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    (async () => {
      const res = await fetch("/api/jobs");
      if (!res.ok || !active) return;
      const data = await res.json();
      if (active) setJobs(data.jobs ?? []);
    })();
    return () => {
      active = false;
    };
  }, [refreshKey]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDelete = async (id: string) => {
    setDeleting((prev) => new Set(prev).add(id));
    try {
      await fetch(`/api/jobs/${id}`, { method: "DELETE" });
      setJobs((prev) => prev?.filter((j) => j.id !== id) ?? null);
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  if (jobs === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-zinc-500">
        <Loader2 size={14} className="animate-spin" /> Loading library…
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] py-16 text-center text-sm text-zinc-500">
        No videos processed yet. Switch to &quot;New Clip&quot; to get started.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {jobs.map((job) => {
        const isOpen = expanded.has(job.id);
        return (
          <motion.div
            key={job.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]"
          >
            <div className="flex items-center gap-3 px-5 py-4">
              <button
                onClick={() => toggle(job.id)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                {isOpen ? (
                  <ChevronDown size={16} className="shrink-0 text-zinc-500" />
                ) : (
                  <ChevronRight size={16} className="shrink-0 text-zinc-500" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-zinc-200">{job.sourceLabel}</div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    {new Date(job.createdAt).toLocaleString()}
                    {job.clips?.length ? ` · ${job.clips.length} clip${job.clips.length === 1 ? "" : "s"}` : ""}
                  </div>
                </div>
              </button>
              <span
                className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium ${statusColor(job.status)}`}
              >
                {statusLabel(job.status)}
              </span>
              <button
                onClick={() => handleDelete(job.id)}
                disabled={deleting.has(job.id)}
                className="shrink-0 rounded-lg p-2 text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40"
                title="Delete"
              >
                {deleting.has(job.id) ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
              </button>
            </div>

            {isOpen && (
              <div className="border-t border-white/10 px-5 py-5">
                {job.status === "error" && (
                  <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                    <AlertTriangle size={16} className="shrink-0" /> {job.error ?? job.progressMessage}
                  </div>
                )}
                {!job.clips || job.clips.length === 0 ? (
                  <p className="text-sm text-zinc-500">
                    {job.status === "done" ? "No clips were produced for this video." : job.progressMessage}
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                    {job.clips.map((clip, i) => (
                      <ClipCard key={clip.id} jobId={job.id} clip={clip} index={i} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}
