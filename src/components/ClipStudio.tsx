"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Link2, UploadCloud, Sparkles, AlertTriangle, Loader2, Library as LibraryIcon, Clapperboard, GitCompare, KeyRound } from "lucide-react";
import type { Job } from "@/lib/jobs";
import ClipCard from "./ClipCard";
import Library from "./Library";
import Compare from "./Compare";
import KeyManagement from "./KeyManagement";
import { CLIP_LENGTH_PRESETS, DEFAULT_CLIP_LENGTH, type ClipLengthPreset } from "@/lib/clipLength";

const LAST_JOB_KEY = "clipstudio:lastJobId";

const STAGES: Array<{ key: Job["status"]; label: string }> = [
  { key: "downloading", label: "Ingest" },
  { key: "uploading", label: "Upload" },
  { key: "analyzing", label: "Analyze" },
  { key: "ranking", label: "Rank" },
  { key: "cutting", label: "Render" },
  { key: "done", label: "Done" },
];

function stageIndex(status: Job["status"]): number {
  if (status === "queued" || status === "probing") return 0;
  const idx = STAGES.findIndex((s) => s.key === status);
  return idx === -1 ? 0 : idx;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function ClipStudio() {
  const [tab, setTab] = useState<"new" | "library" | "compare" | "keys">("new");
  const [mode, setMode] = useState<"url" | "file">("url");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [clipLength, setClipLength] = useState<ClipLengthPreset>(DEFAULT_CLIP_LENGTH);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollJob = useCallback((jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (!res.ok) return;
      const data: Job = await res.json();
      setJob(data);
      if (data.status === "done" || data.status === "error" || data.status === "cancelled") {
        if (pollRef.current) clearInterval(pollRef.current);
        setLibraryRefreshKey((k) => k + 1);
      }
    }, 1500);
  }, []);

  // Resume whatever job was last active across page reloads — this is what
  // was missing before: a reload used to lose track of an in-progress or
  // just-finished job entirely, even though the work itself kept running.
  useEffect(() => {
    const lastJobId = localStorage.getItem(LAST_JOB_KEY);
    if (!lastJobId) return;
    (async () => {
      const res = await fetch(`/api/jobs/${lastJobId}`);
      if (!res.ok) return;
      const data: Job = await res.json();
      setJob(data);
      if (data.status !== "done" && data.status !== "error" && data.status !== "cancelled") {
        pollJob(lastJobId);
      }
    })();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [pollJob]);

  const handleSubmit = useCallback(async () => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      let res: Response;
      if (mode === "url") {
        if (!url.trim()) throw new Error("Paste a video URL first.");
        res = await fetch("/api/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url.trim(), clipLength }),
        });
      } else {
        if (!file) throw new Error("Choose a video file first.");
        const form = new FormData();
        form.append("file", file);
        form.append("clipLength", clipLength);
        res = await fetch("/api/jobs", { method: "POST", body: form });
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Request failed." }));
        throw new Error(body.error ?? "Request failed.");
      }
      const data = await res.json();
      localStorage.setItem(LAST_JOB_KEY, data.jobId);
      setJob({
        id: data.jobId,
        status: "queued",
        progressMessage: "Queued",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sourceLabel: mode === "url" ? url : file?.name ?? "upload",
      });
      pollJob(data.jobId);
      setLibraryRefreshKey((k) => k + 1);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [mode, url, file, clipLength, pollJob]);

  const isProcessing = Boolean(
    job && job.status !== "done" && job.status !== "error" && job.status !== "cancelled"
  );

  const handleCancel = useCallback(async () => {
    if (!job) return;
    try {
      await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
    } finally {
      if (pollRef.current) clearInterval(pollRef.current);
      setJob((prev) => (prev ? { ...prev, status: "cancelled", progressMessage: "Cancelled by user" } : prev));
      setLibraryRefreshKey((k) => k + 1);
    }
  }, [job]);

  const handleStartNew = useCallback(() => {
    localStorage.removeItem(LAST_JOB_KEY);
    setJob(null);
    setUrl("");
    setFile(null);
  }, []);

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-6 py-16">
      <motion.header
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-10 flex flex-col items-center text-center"
      >
        <div className="mb-4 flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-4 py-1.5 text-sm text-violet-300">
          <Sparkles size={14} />
          AI-powered viral clip extraction
        </div>
        <h1 className="bg-gradient-to-br from-white via-zinc-100 to-zinc-400 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl">
          Clip Studio
        </h1>
        <p className="mt-3 max-w-xl text-zinc-400">
          Drop in a long-form video or link. Gemini finds the moments with the best hook
          potential, then renders them as ready-to-post 9:16 clips with captions.
        </p>
      </motion.header>

      <div className="mb-8 flex justify-center gap-2 rounded-xl border border-white/10 bg-black/20 p-1">
        <button
          onClick={() => setTab("new")}
          className={`flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-colors ${
            tab === "new" ? "bg-violet-600 text-white" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <Clapperboard size={15} /> New Clip
        </button>
        <button
          onClick={() => setTab("library")}
          className={`flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-colors ${
            tab === "library" ? "bg-violet-600 text-white" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <LibraryIcon size={15} /> Library
        </button>
        <button
          onClick={() => setTab("compare")}
          className={`flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-colors ${
            tab === "compare" ? "bg-violet-600 text-white" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <GitCompare size={15} /> Compare Models
        </button>
        <button
          onClick={() => setTab("keys")}
          className={`flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-colors ${
            tab === "keys" ? "bg-violet-600 text-white" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <KeyRound size={15} /> API Keys
        </button>
      </div>

      {tab === "library" ? (
        <Library refreshKey={libraryRefreshKey} />
      ) : tab === "compare" ? (
        <Compare />
      ) : tab === "keys" ? (
        <KeyManagement />
      ) : (
        <>
          {!job && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 shadow-2xl backdrop-blur-xl sm:p-8"
            >
              <div className="mb-6 flex gap-2 rounded-xl bg-black/30 p-1">
                <button
                  onClick={() => setMode("url")}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-medium transition-colors ${
                    mode === "url" ? "bg-violet-600 text-white" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <Link2 size={15} /> Link
                </button>
                <button
                  onClick={() => setMode("file")}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-medium transition-colors ${
                    mode === "file" ? "bg-violet-600 text-white" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <UploadCloud size={15} /> Upload
                </button>
              </div>

              {mode === "url" ? (
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="YouTube, Instagram, TikTok, Facebook, or direct podcast link…"
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
                />
              ) : (
                <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 bg-black/20 py-10 text-sm text-zinc-400 transition-colors hover:border-violet-500/50">
                  <UploadCloud size={22} />
                  {file ? file.name : "Click to choose an MP4 (up to 2GB)"}
                  <input
                    type="file"
                    accept="video/mp4,video/quicktime,video/x-matroska,video/webm"
                    className="hidden"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              )}

              <div className="mt-5">
                <div className="mb-2 text-xs font-medium text-zinc-400">Clip length</div>
                <div className="flex gap-2 rounded-xl bg-black/30 p-1">
                  {(Object.keys(CLIP_LENGTH_PRESETS) as ClipLengthPreset[]).map((key) => {
                    const preset = CLIP_LENGTH_PRESETS[key];
                    return (
                      <button
                        key={key}
                        onClick={() => setClipLength(key)}
                        className={`flex flex-1 flex-col items-center rounded-lg py-2 text-sm font-medium transition-colors ${
                          clipLength === key ? "bg-violet-600 text-white" : "text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        {preset.label}
                        <span className="text-xs font-normal opacity-75">
                          {preset.minSeconds}-{preset.maxSeconds}s
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {submitError && (
                <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                  <AlertTriangle size={16} /> {submitError}
                </div>
              )}

              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 py-3.5 text-sm font-semibold text-white shadow-lg shadow-violet-900/30 transition-transform hover:scale-[1.01] disabled:opacity-50 disabled:hover:scale-100"
              >
                {submitting ? (
                  <>
                    <Loader2 size={16} className="animate-spin" /> Starting…
                  </>
                ) : (
                  <>
                    <Sparkles size={16} /> Find viral clips
                  </>
                )}
              </button>
            </motion.div>
          )}

          <AnimatePresence>
            {job && (
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                <div className="mb-4 flex items-center justify-between">
                  <span className="truncate text-sm text-zinc-500">{job.sourceLabel}</span>
                  {!isProcessing && (
                    <button
                      onClick={handleStartNew}
                      className="shrink-0 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-violet-500/40 hover:text-violet-300"
                    >
                      Start a new clip
                    </button>
                  )}
                </div>

                {job.status !== "done" && (
                  <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
                    <div className="mb-5 flex items-center justify-between">
                      {STAGES.map((stage, i) => {
                        const current = stageIndex(job.status);
                        const active = i <= current;
                        return (
                          <div key={stage.key} className="flex flex-1 flex-col items-center">
                            <div
                              className={`mb-1.5 h-2.5 w-2.5 rounded-full transition-colors ${
                                active ? "bg-violet-400" : "bg-white/10"
                              } ${i === current && job.status !== "error" ? "animate-pulse" : ""}`}
                            />
                            <span className={`text-[11px] ${active ? "text-zinc-300" : "text-zinc-600"}`}>
                              {stage.label}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {job.status === "error" ? (
                      <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                        <AlertTriangle size={16} className="shrink-0" /> {job.error ?? job.progressMessage}
                      </div>
                    ) : job.status === "cancelled" ? (
                      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-zinc-400">
                        <AlertTriangle size={16} className="shrink-0" /> Cancelled
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2 text-sm text-zinc-400">
                          <Loader2 size={14} className="shrink-0 animate-spin text-violet-400" />
                          <span className="truncate">{job.progressMessage}</span>
                        </div>
                        <button
                          onClick={handleCancel}
                          className="shrink-0 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-red-500/40 hover:text-red-300"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {job.status === "done" && (
                  <div>
                    <h2 className="mb-4 text-lg font-semibold text-zinc-200">
                      {job.clips?.length ?? 0} clip{(job.clips?.length ?? 0) === 1 ? "" : "s"} ready
                      {job.videoDurationSeconds ? ` · from ${formatTime(job.videoDurationSeconds)} source` : ""}
                    </h2>
                    {!job.clips || job.clips.length === 0 ? (
                      <p className="text-sm text-zinc-500">No clips were produced for this video.</p>
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
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}
