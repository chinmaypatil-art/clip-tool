"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Redo2, RotateCcw, Undo2, X } from "lucide-react";
import type { Caption } from "@remotion/captions";
import type { AnalysisClip } from "@/lib/analyses";
import type { ClipEdit, LayoutOverride } from "@/lib/clipEdit";
import { DEFAULT_CAPTION_STYLE } from "@/lib/captionStyle";
import { CaptionStylePicker } from "./CaptionStylePicker";
import { clock, cn } from "./format";

/** A caption word in source seconds. */
interface Word {
  text: string;
  start: number;
  end: number;
  ms: number;
}

const inRanges = (t: number, ranges: [number, number][]) => ranges.some(([s, e]) => t >= s && t < e);

/**
 * The clip editor: a live preview of the source with removed parts skipped,
 * a clickable transcript (remove words, set start/end, fix spelling, layout)
 * and per-clip options. Edits are one list with undo; Save stores it and
 * re-renders. The preview plays the source, so hook-first and pause trimming
 * only show in the rendered clip.
 */
export function ClipEditor({
  analysisId,
  runId,
  clip,
  onClose,
  onSaved,
}: {
  analysisId: string;
  runId: string;
  clip: AnalysisClip;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [history, setHistory] = useState<ClipEdit[]>([clip.edit ?? {}]);
  const [at, setAt] = useState(0);
  const edit = history[at];
  const [start, setStart] = useState(clip.startSeconds);
  const [end, setEnd] = useState(clip.endSeconds);
  const [words, setWords] = useState<Word[] | null>(clip.wordsFilename ? null : []);
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [tab, setTab] = useState<"transcript" | "options">("transcript");
  const [fixing, setFixing] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(clip.startSeconds);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const base = clip.renderedStartSeconds ?? clip.startSeconds;
    if (!clip.wordsFilename) return;
    fetch(`/api/analyses/${analysisId}/files/${clip.wordsFilename}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((caps: Caption[]) =>
        setWords(caps.map((c) => ({ text: c.text, start: base + c.startMs / 1000, end: base + c.endMs / 1000, ms: Math.round(base * 1000 + c.startMs) })))
      )
      .catch(() => setWords([]));
  }, [analysisId, clip.wordsFilename, clip.renderedStartSeconds, clip.startSeconds]);

  const change = (next: ClipEdit) => {
    setHistory((h) => [...h.slice(0, at + 1), next]);
    setAt((a) => a + 1);
  };
  const removed = useMemo(() => edit.removed ?? [], [edit.removed]);
  const fixes = new Map((edit.wordFixes ?? []).map((f) => [f.ms, f.text]));
  const selWords = sel && words ? words.slice(Math.min(...sel), Math.max(...sel) + 1) : [];
  const selRange: [number, number] | null = selWords.length ? [selWords[0].start, selWords.at(-1)!.end] : null;
  const selRemoved = selWords.length > 0 && selWords.every((w) => inRanges((w.start + w.end) / 2, removed));

  // Preview: play start..end of the source, jumping over removed stretches.
  const onTime = () => {
    const v = video.current;
    if (!v) return;
    setNow(v.currentTime);
    const cut = removed.find(([s, e]) => v.currentTime >= s && v.currentTime < e);
    if (cut) v.currentTime = cut[1];
    else if (v.currentTime >= end || v.currentTime < start - 0.5) {
      v.pause();
      v.currentTime = start;
    }
  };

  const toggleRemove = () => {
    if (!selRange) return;
    const next: [number, number][] = selRemoved
      ? removed.filter(([s, e]) => e <= selRange[0] || s >= selRange[1])
      : [...removed, selRange];
    change({ ...edit, removed: next });
    setSel(null);
  };
  const setLayout = (mode: LayoutOverride["mode"] | "auto") => {
    if (!selRange) return;
    const rest = (edit.layout ?? []).filter((l) => l.toSeconds <= selRange[0] || l.fromSeconds >= selRange[1]);
    change({ ...edit, layout: mode === "auto" ? rest : [...rest, { fromSeconds: selRange[0], toSeconds: selRange[1], mode, focusX: 50 }] });
  };
  const applyFix = () => {
    if (selWords.length !== 1 || !fixing.trim()) return;
    const ms = selWords[0].ms;
    change({ ...edit, wordFixes: [...(edit.wordFixes ?? []).filter((f) => f.ms !== ms), { ms, text: fixing.trim() }] });
    setFixing("");
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const url = `/api/analyses/${analysisId}/runs/${runId}/clips/${clip.id}`;
      const edges = start !== clip.startSeconds || end !== clip.endSeconds ? { startSeconds: start, endSeconds: end } : {};
      const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ edit, ...edges }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Save failed");
      const r = await fetch(`/api/analyses/${analysisId}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets: [{ runId, clipId: clip.id }] }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Render failed to start");
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const kept = (words ?? []).filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05 && !inRanges((w.start + w.end) / 2, removed));
  const btn = "rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-xs text-zinc-200 transition hover:bg-white/[0.12] disabled:opacity-40";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur" role="dialog" aria-modal="true" aria-label="Edit clip">
      <div className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-zinc-950 ring-1 ring-white/10">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100">Edit: {clip.title}</h2>
          <button className={btn} onClick={() => setAt((a) => a - 1)} disabled={at === 0} aria-label="Undo">
            <Undo2 size={13} />
          </button>
          <button className={btn} onClick={() => setAt((a) => a + 1)} disabled={at === history.length - 1} aria-label="Redo">
            <Redo2 size={13} />
          </button>
          <button
            className={cn(btn, "flex items-center gap-1")}
            onClick={() => {
              change({});
              setStart(clip.modelStartSeconds ?? clip.startSeconds);
              setEnd(clip.modelEndSeconds ?? clip.endSeconds);
            }}
          >
            <RotateCcw size={12} /> Reset to AI version
          </button>
          <button className={btn} onClick={onClose} aria-label="Close">
            <X size={13} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 md:flex-row">
          <div className="md:w-64 md:shrink-0">
            <video
              ref={video}
              src={`/api/analyses/${analysisId}/files/source.mp4#t=${start}`}
              controls
              preload="metadata"
              onTimeUpdate={onTime}
              onPlay={() => {
                const v = video.current;
                if (v && (v.currentTime < start - 0.5 || v.currentTime >= end)) v.currentTime = start;
              }}
              className="aspect-video w-full rounded-xl bg-black"
            />
            <p className="mt-2 text-[11px] tabular-nums text-zinc-500">
              {clock(Math.max(0, now - start))} · clip {clock(end - start)} · about {clock(kept.length ? end - start - removed.reduce((n, [s, e]) => n + Math.max(0, Math.min(e, end) - Math.max(s, start)), 0) : end - start)} after cuts
            </p>
            <p className="mt-1 text-[11px] text-zinc-600">Preview skips removed words. Hook-first, pause trimming and framing show after Save.</p>
          </div>

          <div className="min-w-0 flex-1">
            <div className="mb-3 flex gap-1">
              {(["transcript", "options"] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)} className={cn("rounded-lg px-3 py-1.5 text-xs capitalize", tab === t ? "bg-white text-zinc-900" : "text-zinc-400 hover:text-zinc-200")}>
                  {t}
                </button>
              ))}
            </div>

            {tab === "transcript" &&
              (words === null ? (
                <Loader2 size={16} className="animate-spin text-zinc-500" />
              ) : words.length === 0 ? (
                <p className="text-xs text-zinc-500">No transcript for this clip yet. Render it once (or Save) and reopen the editor.</p>
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    <button className={btn} disabled={!selRange} onClick={toggleRemove}>
                      {selRemoved ? "Restore" : "Remove"} words
                    </button>
                    <button className={btn} disabled={!selRange} onClick={() => selRange && setStart(Math.max(clip.startSeconds - 60, selRange[0] - 0.05))}>
                      Start here
                    </button>
                    <button className={btn} disabled={!selRange} onClick={() => selRange && setEnd(selRange[1] + 0.15)}>
                      End here
                    </button>
                    <select
                      className="rounded-lg bg-white/[0.06] px-2 py-1.5 text-xs text-zinc-200 disabled:opacity-40"
                      disabled={!selRange}
                      value=""
                      onChange={(e) => setLayout(e.target.value as LayoutOverride["mode"] | "auto")}
                      aria-label="Layout for the selected words"
                    >
                      <option value="" disabled>
                        Layout…
                      </option>
                      <option value="auto">Automatic</option>
                      <option value="fill">Close-up (full screen)</option>
                      <option value="wide">Wide (show gestures)</option>
                      <option value="fit">Whole frame</option>
                    </select>
                    {selWords.length === 1 && (
                      <form
                        className="flex gap-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          applyFix();
                        }}
                      >
                        <input value={fixing} onChange={(e) => setFixing(e.target.value)} placeholder="Correct spelling" aria-label="Correct spelling" className="w-32 rounded-lg bg-white/[0.06] px-2 py-1.5 text-xs text-zinc-100" />
                        <button className={btn} disabled={!fixing.trim()}>
                          Fix
                        </button>
                      </form>
                    )}
                  </div>
                  <p className="mb-2 text-[11px] text-zinc-600">Click a word, shift-click another to select a stretch.</p>
                  <div className="max-h-[55vh] overflow-y-auto rounded-xl bg-white/[0.02] p-3 text-sm leading-7">
                    {words.map((w, i) => {
                      const out = w.start < start - 0.05 || w.end > end + 0.05;
                      const cut = inRanges((w.start + w.end) / 2, removed);
                      const picked = sel && i >= Math.min(...sel) && i <= Math.max(...sel);
                      const playing = now >= w.start && now < w.end;
                      return (
                        <button
                          key={w.ms}
                          onClick={(e) => {
                            setSel(e.shiftKey && sel ? [sel[0], i] : [i, i]);
                            setFixing("");
                            if (video.current) video.current.currentTime = w.start;
                          }}
                          className={cn(
                            "rounded px-0.5",
                            picked ? "bg-sky-500/40 text-white" : playing ? "bg-white/15" : "hover:bg-white/10",
                            cut || out ? "text-zinc-600 line-through" : "text-zinc-200"
                          )}
                        >
                          {fixes.get(w.ms) ?? w.text.trim()}
                        </button>
                      );
                    })}
                  </div>
                </>
              ))}

            {tab === "options" && (
              <div className="space-y-4 text-xs text-zinc-300">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={edit.hook !== false} disabled={clip.hookStartSeconds === undefined} onChange={(e) => change({ ...edit, hook: e.target.checked })} />
                  Hook-first opening {clip.hookStartSeconds === undefined && <span className="text-zinc-600">(no hook picked for this clip)</span>}
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={edit.trimPauses !== false} onChange={(e) => change({ ...edit, trimPauses: e.target.checked })} />
                  Shorten long pauses
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={edit.captionStyle !== null} onChange={(e) => change({ ...edit, captionStyle: e.target.checked ? undefined : null })} />
                  Captions
                </label>
                {edit.captionStyle !== null && (
                  <div>
                    <label className="mb-2 flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={edit.captionStyle !== undefined}
                        onChange={(e) => change({ ...edit, captionStyle: e.target.checked ? DEFAULT_CAPTION_STYLE : undefined })}
                      />
                      Own caption style for this clip
                    </label>
                    {edit.captionStyle && <CaptionStylePicker style={edit.captionStyle} onChange={(s) => change({ ...edit, captionStyle: s })} />}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-white/10 px-4 py-3">
          {error && <span className="flex-1 text-xs text-red-400">{error}</span>}
          <span className="flex-1" />
          <button onClick={onClose} className={btn}>
            Cancel
          </button>
          <button onClick={save} disabled={saving || clip.renderStatus === "rendering"} className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-zinc-200 disabled:opacity-40">
            {saving && <Loader2 size={12} className="animate-spin" />} Save &amp; render
          </button>
        </div>
      </div>
    </div>
  );
}
