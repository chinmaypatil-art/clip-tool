"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Link2,
  UploadCloud,
  Sparkles,
  Loader2,
  AlertTriangle,
  Download,
  Play,
  History,
  Trash2,
  HardDrive,
} from "lucide-react";
import { ClipReviewPanel } from "./ClipReviewPanel";
import type { ClipReview } from "@/lib/review";
import type { TranscriptSegment } from "@/lib/transcript";
import { CLIP_LENGTH_PRESETS, DEFAULT_CLIP_LENGTH, type ClipLengthPreset } from "@/lib/clipLength";

type RunStatus = "queued" | "running" | "done" | "error";
type RenderStatus = "pending" | "rendering" | "done" | "error";

interface AnalysisClip {
  id: string;
  startSeconds: number;
  endSeconds: number;
  title: string;
  hook: string;
  description: string;
  reasoning: string;
  viralScore: number;
  category: string;
  engagementPotential: string;
  renderStatus: RenderStatus;
  renderFilename?: string;
  renderThumbnailFilename?: string;
  renderError?: string;
  modelStartSeconds?: number;
  modelEndSeconds?: number;
  renderedStartSeconds?: number;
  renderedEndSeconds?: number;
  review?: ClipReview;
}

interface ModelRun {
  id: string;
  provider: string;
  model: string;
  status: RunStatus;
  durationMs: number | null;
  tokenUsage: { inputTokens?: number; outputTokens?: number } | null;
  keyLabel: string | null;
  error: string | null;
  clips: AnalysisClip[];
}

interface Analysis {
  id: string;
  sourceLabel: string;
  status: "extracting_transcript" | "ready" | "error";
  error: string | null;
  createdAt: number;
  videoDurationSeconds: number | null;
  transcript: { segments: TranscriptSegment[]; language: string; source: string } | null;
  runs: ModelRun[];
  sourceDeleted?: boolean;
}

interface TrainingStats {
  reviews: number;
  good: number;
  examples: number;
}

interface ProviderInfo {
  id: string;
  label: string;
  models: { id: string; label: string; free?: boolean }[];
  hasKey: boolean;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function overlapRatio(a: AnalysisClip, b: AnalysisClip): number {
  const interStart = Math.max(a.startSeconds, b.startSeconds);
  const interEnd = Math.min(a.endSeconds, b.endSeconds);
  const inter = Math.max(0, interEnd - interStart);
  const union = Math.max(a.endSeconds, b.endSeconds) - Math.min(a.startSeconds, b.startSeconds);
  return union > 0 ? inter / union : 0;
}

const OPEN_ANALYSIS_KEY = "compare.openAnalysisId";

// Storage can be unavailable (private mode, blocked site data); the page
// still works then, it just won't reopen the analysis after a tab switch.
function openAnalysisId(): string | null {
  try {
    return localStorage.getItem(OPEN_ANALYSIS_KEY);
  } catch {
    return null;
  }
}

function rememberOpenAnalysis(id: string | null): void {
  try {
    if (id) localStorage.setItem(OPEN_ANALYSIS_KEY, id);
    else localStorage.removeItem(OPEN_ANALYSIS_KEY);
  } catch {}
}

const RUN_COLORS =["#a78bfa", "#60a5fa", "#34d399", "#f472b6", "#fbbf24", "#fb7185"];

export default function Compare() {
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"url" | "file">("url");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clipLength, setClipLength] = useState<ClipLengthPreset>(DEFAULT_CLIP_LENGTH);
  const [starting, setStarting] = useState(false);
  const [history, setHistory] = useState<Analysis[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [training, setTraining] = useState<TrainingStats | null>(null);
  const [deleteRenders, setDeleteRenders] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);

  const refreshTraining = useCallback(async () => {
    const res = await fetch("/api/training");
    if (res.ok) setTraining(await res.json());
  }, []);

  useEffect(() => {
    fetch("/api/training")
      .then((r) => r.json())
      .then(setTraining);
  }, []);

  useEffect(() => {
    fetch("/api/analyses?providers=1")
      .then((r) => r.json())
      .then((d) => setProviders(d.providers ?? []));
  }, []);

  const loadHistory = useCallback(async () => {
    const res = await fetch("/api/analyses");
    const data = await res.json();
    setHistory(data.analyses ?? []);
  }, []);

  const poll = useCallback((id: string) => {
    rememberOpenAnalysis(id);
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/analyses/${id}`);
      if (res.status === 404) {
        // Deleted elsewhere: stop polling it and don't reopen it next time.
        if (pollRef.current) clearInterval(pollRef.current);
        rememberOpenAnalysis(null);
        setAnalysis(null);
        return;
      }
      if (!res.ok) return;
      const data: Analysis = await res.json();
      setAnalysis(data);
      const allRunsSettled = data.runs.length === 0 || data.runs.every((r) => r.status === "done" || r.status === "error");
      const allClipsSettled = data.runs.every((r) => r.clips.every((c) => c.renderStatus !== "rendering"));
      if ((data.status === "ready" && allRunsSettled && allClipsSettled) || data.status === "error") {
        // Keep polling slowly in case a render/run is still pending the user
        // just queued — but we don't need to spin fast once nothing's moving.
      }
    }, 2000);
  }, []);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Switching tabs unmounts this component; reopen the analysis that was open
  // instead of showing an empty page while its runs continue on the server.
  useEffect(() => {
    const id = openAnalysisId();
    if (!id) return;
    fetch(`/api/analyses/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Analysis | null) => {
        if (!data) return rememberOpenAnalysis(null);
        setAnalysis(data);
        poll(id);
      });
  }, [poll]);

  const handleSubmit = useCallback(async () => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      let res: Response;
      if (mode === "url") {
        if (!url.trim()) throw new Error("Paste a video URL first.");
        res = await fetch("/api/analyses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url.trim() }),
        });
      } else {
        if (!file) throw new Error("Choose a video file first.");
        const form = new FormData();
        form.append("file", file);
        res = await fetch("/api/analyses", { method: "POST", body: form });
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Request failed." }));
        throw new Error(body.error ?? "Request failed.");
      }
      const data = await res.json();
      setAnalysis({
        id: data.analysisId,
        sourceLabel: mode === "url" ? url : file?.name ?? "upload",
        status: "extracting_transcript",
        error: null,
        createdAt: Date.now(),
        videoDurationSeconds: null,
        transcript: null,
        runs: [],
      });
      poll(data.analysisId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [mode, url, file, poll]);

  const toggleModel = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const runningKeys = new Set(
    (analysis?.runs ?? []).filter((r) => r.status === "running").map((r) => `${r.provider}::${r.model}`)
  );
  const runnable = [...selected].filter((key) => !runningKeys.has(key));

  const handleRunAnalysis = async () => {
    if (!analysis || runnable.length === 0 || starting) return;
    setStarting(true);
    try {
      const models = runnable.map((key) => {
        const [provider, ...rest] = key.split("::");
        return { provider, model: rest.join("::") };
      });
      await fetch(`/api/analyses/${analysis.id}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models, clipLength }),
      });
      poll(analysis.id);
    } finally {
      setStarting(false);
    }
  };

  const handleRender = async (runId: string, clipId: string) => {
    if (!analysis) return;
    await fetch(`/api/analyses/${analysis.id}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets: [{ runId, clipId }] }),
    });
    poll(analysis.id);
  };

  const refreshAnalysis = async () => {
    if (!analysis) return;
    const res = await fetch(`/api/analyses/${analysis.id}`);
    if (res.ok) setAnalysis(await res.json());
    refreshTraining();
  };

  const handleCleanup = async () => {
    if (!analysis || cleaning) return;
    setCleaning(true);
    setCleanupError(null);
    try {
      const res = await fetch(`/api/analyses/${analysis.id}/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ renders: deleteRenders }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Cleanup failed.");
      await refreshAnalysis();
    } catch (err) {
      setCleanupError(err instanceof Error ? err.message : String(err));
    } finally {
      setCleaning(false);
    }
  };

  const handleOpenHistory = async (id: string) => {
    const res = await fetch(`/api/analyses/${id}`);
    if (!res.ok) return;
    setAnalysis(await res.json());
    setShowHistory(false);
    poll(id);
  };

  const handleDeleteHistory = async (id: string) => {
    await fetch(`/api/analyses/${id}`, { method: "DELETE" });
    loadHistory();
  };

  const duration = analysis?.videoDurationSeconds ?? 0;
  const allClips: Array<{ clip: AnalysisClip; runIndex: number }> = [];
  analysis?.runs.forEach((run, i) => run.clips.forEach((clip) => allClips.push({ clip, runIndex: i })));
  const reviewedCount = allClips.filter(({ clip }) => clip.review).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">Multi-model clip comparison</h2>
        <button
          onClick={() => {
            setShowHistory((v) => !v);
            if (!showHistory) loadHistory();
          }}
          className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-400 hover:border-violet-500/40 hover:text-violet-300"
        >
          <History size={13} /> History
        </button>
      </div>

      {showHistory && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          {history === null ? (
            <Loader2 size={14} className="animate-spin text-zinc-500" />
          ) : history.length === 0 ? (
            <p className="text-sm text-zinc-500">No previous analyses.</p>
          ) : (
            <div className="space-y-2">
              {history.map((a) => (
                <div key={a.id} className="flex items-center gap-3 rounded-lg bg-black/20 px-3 py-2">
                  <button onClick={() => handleOpenHistory(a.id)} className="min-w-0 flex-1 truncate text-left text-sm text-zinc-300 hover:text-violet-300">
                    {a.sourceLabel}
                  </button>
                  <span className="shrink-0 text-[11px] text-zinc-500">{a.runs.length} run{a.runs.length === 1 ? "" : "s"}</span>
                  <button onClick={() => handleDeleteHistory(a.id)} className="shrink-0 rounded p-1 text-zinc-500 hover:text-red-300">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!analysis && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <div className="mb-4 flex gap-2 rounded-xl bg-black/30 p-1">
            <button
              onClick={() => setMode("url")}
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium ${mode === "url" ? "bg-violet-600 text-white" : "text-zinc-400"}`}
            >
              <Link2 size={14} /> Link
            </button>
            <button
              onClick={() => setMode("file")}
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium ${mode === "file" ? "bg-violet-600 text-white" : "text-zinc-400"}`}
            >
              <UploadCloud size={14} /> Upload
            </button>
          </div>
          {mode === "url" ? (
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="YouTube link (for transcript-based analysis) or other source…"
              className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-500"
            />
          ) : (
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-white/15 bg-black/20 py-8 text-sm text-zinc-400">
              <UploadCloud size={20} />
              {file ? file.name : "Choose a video file"}
              <input type="file" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
          )}
          {submitError && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              <AlertTriangle size={13} /> {submitError}
            </div>
          )}
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 py-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            {submitting ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />} Extract transcript
          </button>
        </div>
      )}

      {analysis && (
        <div className="space-y-5">
          <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-3">
            <span className="truncate text-sm text-zinc-400">{analysis.sourceLabel}</span>
            <button
              onClick={() => {
                if (pollRef.current) clearInterval(pollRef.current);
                rememberOpenAnalysis(null);
                setAnalysis(null);
                setSelected(new Set());
              }}
              className="shrink-0 rounded-lg border border-white/10 px-3 py-1 text-xs text-zinc-400 hover:text-violet-300"
            >
              New analysis
            </button>
          </div>

          {allClips.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-3 text-xs text-zinc-400">
              <span>
                Reviewed <span className="font-semibold text-zinc-200">{reviewedCount}/{allClips.length}</span> clips
              </span>
              {training && (
                <span className="text-zinc-500">
                  Training data: {training.reviews} reviews ({training.good} good) · {training.examples} examples in
                  storage/training/sft.jsonl
                </span>
              )}
              <div className="ml-auto flex items-center gap-3">
                {analysis.sourceDeleted ? (
                  <span className="flex items-center gap-1.5 text-zinc-500">
                    <HardDrive size={12} /> Video deleted, reviews kept
                  </span>
                ) : (
                  <>
                    <label className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                      <input type="checkbox" checked={deleteRenders} onChange={(e) => setDeleteRenders(e.target.checked)} />
                      also delete rendered clips
                    </label>
                    <button
                      onClick={handleCleanup}
                      disabled={reviewedCount < allClips.length || cleaning}
                      title={reviewedCount < allClips.length ? "Review every clip first" : "Delete the downloaded video, keep the training data"}
                      className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1 text-[11px] text-zinc-300 hover:border-violet-500/40 hover:text-violet-300 disabled:opacity-40"
                    >
                      {cleaning ? <Loader2 size={11} className="animate-spin" /> : <HardDrive size={11} />} Done, free up space
                    </button>
                  </>
                )}
              </div>
              {cleanupError && <p className="w-full text-[11px] text-red-300">{cleanupError}</p>}
            </div>
          )}

          {analysis.status === "extracting_transcript" && (
            <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-sm text-zinc-400">
              <Loader2 size={15} className="animate-spin text-violet-400" /> Extracting transcript…
            </div>
          )}

          {analysis.status === "error" && (
            <div className="flex items-center gap-2 rounded-2xl border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-300">
              <AlertTriangle size={15} /> {analysis.error}
            </div>
          )}

          {analysis.status === "ready" && (
            <>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <div className="mb-3 flex items-center justify-between text-xs text-zinc-500">
                  <span>
                    Transcript ready — {analysis.transcript?.segments.length ?? 0} segments,{" "}
                    {analysis.transcript?.source} source
                    {analysis.videoDurationSeconds ? ` · ${formatTime(analysis.videoDurationSeconds)} video` : ""}
                  </span>
                </div>
                <div className="mb-4 flex flex-wrap gap-2">
                  {providers?.every((p) => !p.hasKey) && (
                    <span className="text-xs text-zinc-500">No API keys yet — add one in the API Keys tab.</span>
                  )}
                  {providers?.filter((p) => p.hasKey).map((p) =>
                    p.models.map((m) => {
                      const key = `${p.id}::${m.id}`;
                      const active = selected.has(key);
                      return (
                        <button
                          key={key}
                          onClick={() => toggleModel(key)}
                          className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                            active
                              ? "border-violet-500 bg-violet-500/20 text-violet-200"
                              : "border-white/10 text-zinc-400 hover:border-white/20"
                          }`}
                        >
                          {p.label} · {m.label}
                          {m.free && (
                            <span className="ml-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">Free</span>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
                <div className="mb-4">
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
                <button
                  onClick={handleRunAnalysis}
                  disabled={runnable.length === 0 || starting}
                  className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {starting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Run {runnable.length || ""} model
                  {runnable.length === 1 ? "" : "s"}
                </button>
              </div>

              {duration > 0 && allClips.length > 0 && (
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Unified timeline</h3>
                  <div className="space-y-2">
                    {analysis.runs.map((run, i) => (
                      <div key={run.id} className="flex items-center gap-3">
                        <span className="w-32 shrink-0 truncate text-[11px] text-zinc-500">{run.provider}/{run.model}</span>
                        <div className="relative h-5 flex-1 rounded bg-black/30">
                          {run.clips.map((clip) => {
                            const sharedWithOther = allClips.some(
                              (o) => o.runIndex !== i && overlapRatio(o.clip, clip) > 0.3
                            );
                            return (
                              <div
                                key={clip.id}
                                title={`${clip.title} (${formatTime(clip.startSeconds)}-${formatTime(clip.endSeconds)})`}
                                className="absolute top-0.5 h-4 rounded"
                                style={{
                                  left: `${(clip.startSeconds / duration) * 100}%`,
                                  width: `${Math.max(0.5, ((clip.endSeconds - clip.startSeconds) / duration) * 100)}%`,
                                  backgroundColor: RUN_COLORS[i % RUN_COLORS.length],
                                  opacity: sharedWithOther ? 1 : 0.55,
                                  boxShadow: sharedWithOther ? "0 0 0 1.5px white" : "none",
                                }}
                              />
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-zinc-600">White outline = overlaps with another model&apos;s pick (shared moment)</p>
                </div>
              )}

              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-3">
                {analysis.runs.map((run, i) => (
                  <div key={run.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: RUN_COLORS[i % RUN_COLORS.length] }} />
                        <span className="text-sm font-semibold text-zinc-200">
                          {run.provider} / {run.model}
                        </span>
                      </div>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          run.status === "done"
                            ? "bg-emerald-500/15 text-emerald-300"
                            : run.status === "error"
                            ? "bg-red-500/15 text-red-300"
                            : "bg-violet-500/15 text-violet-300"
                        }`}
                      >
                        {run.status}
                      </span>
                    </div>
                    {run.status === "error" && (
                      <p className="mb-2 text-xs text-red-300">{run.error}</p>
                    )}
                    {run.status === "done" && (
                      <p className="mb-3 text-[11px] text-zinc-500">
                        {run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : ""}
                        {run.tokenUsage ? ` · ${run.tokenUsage.inputTokens ?? "?"}in/${run.tokenUsage.outputTokens ?? "?"}out tokens` : ""}
                        {run.keyLabel ? ` · key: ${run.keyLabel}` : ""}
                      </p>
                    )}
                    <div className="space-y-3">
                      {run.clips.map((clip) => (
                        <div key={clip.id} className="rounded-xl border border-white/5 bg-black/20 p-3">
                          <div className="mb-1 flex items-start justify-between gap-2">
                            <h4 className="text-xs font-semibold text-zinc-100">{clip.title}</h4>
                            <span className="shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] text-violet-300">
                              {Math.round(clip.viralScore)}
                            </span>
                          </div>
                          <p className="mb-1 text-[11px] text-zinc-500">
                            {formatTime(clip.startSeconds)}-{formatTime(clip.endSeconds)} · {clip.category}
                          </p>
                          <p className="mb-1 text-[11px] italic text-zinc-400">&ldquo;{clip.hook}&rdquo;</p>
                          <p className="mb-2 text-[11px] text-zinc-500">{clip.reasoning}</p>
                          {clip.renderStatus === "pending" && !analysis.sourceDeleted && (
                            <button
                              onClick={() => handleRender(run.id, clip.id)}
                              className="flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1.5 text-[11px] text-zinc-300 hover:bg-violet-600 hover:text-white"
                            >
                              <Play size={11} /> Render this clip
                            </button>
                          )}
                          {clip.renderStatus === "rendering" && (
                            <span className="flex items-center gap-1.5 text-[11px] text-violet-300">
                              <Loader2 size={11} className="animate-spin" /> Rendering…
                            </span>
                          )}
                          {clip.renderStatus === "done" && clip.renderFilename && (
                            <div className="mt-1">
                              <video
                                // Re-renders reuse the file name; the edges bust the browser cache.
                                src={`/api/analyses/${analysis.id}/files/${clip.renderFilename}?v=${clip.renderedStartSeconds ?? ""}-${clip.renderedEndSeconds ?? ""}`}
                                poster={clip.renderThumbnailFilename ? `/api/analyses/${analysis.id}/files/${clip.renderThumbnailFilename}` : undefined}
                                controls
                                className="mb-1.5 w-full rounded-lg"
                              />
                              <a
                                href={`/api/analyses/${analysis.id}/files/${clip.renderFilename}`}
                                download
                                className="flex items-center gap-1.5 text-[11px] text-zinc-400 hover:text-violet-300"
                              >
                                <Download size={11} /> Download
                              </a>
                            </div>
                          )}
                          {clip.renderStatus === "error" && (
                            <p className="text-[11px] text-red-300">{clip.renderError}</p>
                          )}
                          {analysis.transcript && (
                            <ClipReviewPanel
                              // Remount after a save so the panel starts from the stored review.
                              key={`${clip.id}-${clip.review?.reviewedAt ?? 0}-${clip.startSeconds}-${clip.endSeconds}`}
                              analysisId={analysis.id}
                              runId={run.id}
                              clip={clip}
                              segments={analysis.transcript.segments}
                              canRender={!analysis.sourceDeleted}
                              onSaved={refreshAnalysis}
                              onRerender={() => handleRender(run.id, clip.id)}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
