"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Loader2, Pause, Play, Redo2, RotateCcw, Send, Sparkles, Trash2, Undo2, Wand2, X } from "lucide-react";
import type { Caption } from "@remotion/captions";
import type { AnalysisClip } from "@/lib/analyses";
import { isBrollVideo, type ClipEdit, type LayoutOverride } from "@/lib/clipEdit";
import type { AiEditOps } from "@/lib/aiEdit";
import { DEFAULT_CAPTION_STYLE } from "@/lib/captionStyle";
import { isFiller } from "@/lib/tighten";
import { CaptionStylePicker } from "./CaptionStylePicker";
import { clock, cn } from "./format";

/** A caption word in source seconds. */
interface Word {
  text: string;
  start: number;
  end: number;
  ms: number;
}
/** One undo step: the edit list plus the clip's edges. */
interface State {
  edit: ClipEdit;
  start: number;
  end: number;
}
type Range = [number, number];

const inRanges = (t: number, ranges: Range[]) => ranges.some(([s, e]) => t >= s && t < e);
const isCut = (w: Word, removed: Range[]) => inRanges((w.start + w.end) / 2, removed);
// Pauses longer than this count as silences for one-click removal (as tighten.ts).
const SILENCE = 0.8;
const SUGGESTIONS = ["Cut the first sentence", "Make it about 30 seconds", "Remove the ums", "Turn off the hook", "Zoom out at the start"];

/** Words grouped into sentences (by . ? !), as word index ranges. */
function sentencesOf(words: Word[]): Array<{ from: number; to: number; text: string }> {
  const out: Array<{ from: number; to: number; text: string }> = [];
  let from = 0;
  words.forEach((w, i) => {
    if (/[.?!]["'”]?$/.test(w.text.trim()) || i === words.length - 1) {
      out.push({ from, to: i, text: words.slice(from, i + 1).map((x) => x.text).join("").trim() });
      from = i + 1;
    }
  });
  return out;
}

/** Edited length: the edges minus removed stretches inside them. */
function lengthOf({ edit, start, end }: State): number {
  return end - start - (edit.removed ?? []).reduce((n, [s, e]) => n + Math.max(0, Math.min(e, end) - Math.max(s, start)), 0);
}

/**
 * The clip editor: a 9:16 preview of the source with removed parts skipped,
 * a timeline, and three ways to edit: Ask AI (type what you want), the
 * transcript (select words to cut, set start/end, fix spelling, framing) and
 * options. Everything is one edit list with undo; Save stores it and
 * re-renders. Hook-first and pause trimming only show in the rendered clip.
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
  const [history, setHistory] = useState<State[]>([{ edit: clip.edit ?? {}, start: clip.startSeconds, end: clip.endSeconds }]);
  const [at, setAt] = useState(0);
  const state = history[at];
  const { edit, start, end } = state;
  const [words, setWords] = useState<Word[] | null>(clip.wordsFilename ? null : []);
  const [sel, setSel] = useState<Range | null>(null);
  const [tab, setTab] = useState<"ai" | "transcript" | "options">("ai");
  const [fixing, setFixing] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(clip.startSeconds);
  const [playing, setPlaying] = useState(false);
  const [vertical, setVertical] = useState(true);
  const [ask, setAsk] = useState("");
  const [thinking, setThinking] = useState(false);
  const [chat, setChat] = useState<Array<{ who: "you" | "ai"; text: string }>>([]);
  const video = useRef<HTMLVideoElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);

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

  useEffect(() => chatEnd.current?.scrollIntoView({ block: "end" }), [chat, thinking]);

  const push = (next: Partial<State>) => {
    setHistory((h) => [...h.slice(0, at + 1), { ...state, ...next }]);
    setAt((a) => a + 1);
  };
  const change = (next: ClipEdit) => push({ edit: next });

  const removed = useMemo(() => edit.removed ?? [], [edit.removed]);
  const all = useMemo(() => words ?? [], [words]);
  const sentences = useMemo(() => sentencesOf(all), [all]);
  const fixes = new Map((edit.wordFixes ?? []).map((f) => [f.ms, f.text]));
  const inClip = (w: Word) => w.start >= start - 0.05 && w.end <= end + 0.05;
  const selWords = sel ? all.slice(Math.min(...sel), Math.max(...sel) + 1) : [];
  const selRange: Range | null = selWords.length ? [selWords[0].start, selWords.at(-1)!.end] : null;
  const selRemoved = selWords.length > 0 && selWords.every((w) => isCut(w, removed));

  // B-roll: the user's own pictures and videos over chosen words (nothing automatic).
  const broll = edit.broll ?? [];
  const brollNow = broll.find((b) => now >= b.fromSeconds && now < b.toSeconds);
  const fileUrl = (name: string) => `/api/analyses/${analysisId}/files/${name}`;
  const picker = useRef<HTMLInputElement>(null);
  const brollFor = useRef<Range | null>(null);
  const [uploading, setUploading] = useState(false);
  const addImage = async (file: File) => {
    const range = brollFor.current;
    if (!range) return;
    setUploading(true);
    setError("");
    try {
      // Raw body, not form data: videos can be far bigger than form uploads allow.
      const res = await fetch(`/api/broll?analysisId=${analysisId}`, { method: "POST", headers: { "Content-Type": file.type }, body: file });
      const body: { file?: string; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !body.file) throw new Error(body.error ?? "Upload failed.");
      change({ ...edit, broll: [...broll, { file: body.file, fromSeconds: range[0], toSeconds: range[1] }] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  // One-click cleanups: fillers ("um") and silences still in the clip.
  const fillerRanges: Range[] = all.filter((w) => inClip(w) && !isCut(w, removed) && isFiller(w.text)).map((w) => [w.start - 0.02, w.end + 0.02]);
  const silenceRanges: Range[] = [];
  const spoken = all.filter((w) => inClip(w) && !isCut(w, removed) && !isFiller(w.text));
  for (let i = 1; i < spoken.length; i++) {
    if (spoken[i].start - spoken[i - 1].end > SILENCE) silenceRanges.push([spoken[i - 1].end + 0.1, spoken[i].start - 0.1]);
  }

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
  const togglePlay = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime < start - 0.5 || v.currentTime >= end) v.currentTime = start;
      v.play();
    } else v.pause();
  };
  const seek = (t: number) => {
    if (video.current) video.current.currentTime = t;
    setNow(t);
  };

  const toggleRemove = () => {
    if (!selRange) return;
    change({ ...edit, removed: selRemoved ? removed.filter(([s, e]) => e <= selRange[0] || s >= selRange[1]) : [...removed, selRange] });
    setSel(null);
  };
  const layoutFor = (range: Range, mode: LayoutOverride["mode"] | "auto", base: ClipEdit = edit): ClipEdit => {
    const rest = (base.layout ?? []).filter((l) => l.toSeconds <= range[0] || l.fromSeconds >= range[1]);
    return { ...base, layout: mode === "auto" ? rest : [...rest, { fromSeconds: range[0], toSeconds: range[1], mode, focusX: 50 }] };
  };
  const applyFix = () => {
    if (selWords.length !== 1 || !fixing.trim()) return;
    const ms = selWords[0].ms;
    change({ ...edit, wordFixes: [...(edit.wordFixes ?? []).filter((f) => f.ms !== ms), { ms, text: fixing.trim() }] });
    setFixing("");
  };

  /** Applies the AI's operations (sentence numbers) to a state. */
  const applyOps = (s: State, ops: AiEditOps): State => {
    const span = (n: number): Range => {
      const x = sentences[n - 1];
      return [all[x.from].start - 0.02, all[x.to].end + 0.05];
    };
    let next: ClipEdit = { ...s.edit };
    let cut = [...(next.removed ?? [])];
    for (const n of ops.restore) {
      const [a, b] = span(n);
      cut = cut.filter(([x, y]) => y <= a || x >= b);
    }
    cut.push(...ops.remove.map(span));
    if (ops.fillers) cut.push(...fillerRanges);
    next.removed = cut;
    if (ops.hook !== null) next.hook = ops.hook;
    if (ops.pauses !== null) next.trimPauses = ops.pauses;
    if (ops.captions !== null) next.captionStyle = ops.captions ? undefined : null;
    for (const l of ops.layout) next = layoutFor([span(l.from)[0], span(l.to)[1]], l.mode, next);
    return {
      edit: next,
      start: ops.start ? span(ops.start)[0] - 0.03 : s.start,
      end: ops.end ? span(ops.end)[1] + 0.1 : s.end,
    };
  };

  const askAi = async (request: string) => {
    if (!request.trim() || thinking || !sentences.length) return;
    setChat((c) => [...c, { who: "you", text: request }]);
    setAsk("");
    setThinking(true);
    const target = Number(request.match(/(\d+)\s*(s\b|sec|second)/i)?.[1]);
    const call = async (req: string, s: State) => {
      const res = await fetch(`/api/analyses/${analysisId}/runs/${runId}/clips/${clip.id}/ai-edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request: req,
          seconds: lengthOf(s),
          sentences: sentences.map((x) => ({ text: x.text, removed: all.slice(x.from, x.to + 1).every((w) => isCut(w, s.edit.removed ?? []) || w.start < s.start - 0.05 || w.end > s.end + 0.05) })),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Ask AI failed");
      return body as AiEditOps;
    };
    try {
      let ops = await call(request, state);
      let next = applyOps(state, ops);
      // A local model undershoots length requests; ask again (twice at most) with the real length.
      for (let i = 0; target && i < 2 && lengthOf(next) > target * 1.15; i++) {
        ops = await call(`It is now ${Math.round(lengthOf(next))} seconds, still too long. Cut more so it is about ${target} seconds.`, next);
        next = applyOps(next, ops);
      }
      push(next);
      const len = Math.round(lengthOf(next));
      setChat((c) => [...c, { who: "ai", text: `${ops.reply || "Done."} Clip is now ${clock(len)}.${target && len > target * 1.15 ? " Still a bit long: cut more in the transcript, or ask again." : ""}` }]);
    } catch (err) {
      setChat((c) => [...c, { who: "ai", text: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setThinking(false);
    }
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

  // Close on Escape, play/pause on space (outside text boxes).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === " " && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const layoutNow = [...(edit.layout ?? [])].reverse().find((l) => now >= l.fromSeconds && now < l.toSeconds);
  const pct = (t: number) => `${Math.min(100, Math.max(0, ((t - start) / (end - start)) * 100))}%`;
  const ghost = "rounded-lg px-2.5 py-1.5 text-xs text-zinc-300 transition hover:bg-white/[0.08] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent";
  const chip = "rounded-full bg-white/[0.06] px-3 py-1.5 text-xs text-zinc-200 ring-1 ring-white/10 transition hover:bg-white/[0.12] disabled:opacity-40";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950" role="dialog" aria-modal="true" aria-label="Edit clip">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-white/[0.08] px-4">
        <button className={ghost} onClick={onClose} aria-label="Close editor">
          <X size={16} />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-zinc-100">{clip.title}</h2>
          <p className="text-[11px] tabular-nums text-zinc-500">
            {clock(lengthOf(state))} after edits · {clock(end - start)} clip
          </p>
        </div>
        <button className={ghost} onClick={() => setAt((a) => a - 1)} disabled={at === 0} title="Undo" aria-label="Undo">
          <Undo2 size={15} />
        </button>
        <button className={ghost} onClick={() => setAt((a) => a + 1)} disabled={at === history.length - 1} title="Redo" aria-label="Redo">
          <Redo2 size={15} />
        </button>
        <button className={cn(ghost, "hidden items-center gap-1.5 sm:flex")} onClick={() => push({ edit: {}, start: clip.modelStartSeconds ?? clip.startSeconds, end: clip.modelEndSeconds ?? clip.endSeconds })}>
          <RotateCcw size={13} /> Reset to AI version
        </button>
        <div className="mx-1 h-6 w-px bg-white/10" />
        <button
          onClick={save}
          disabled={saving || clip.renderStatus === "rendering"}
          className="flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-xs font-semibold text-zinc-900 transition hover:bg-zinc-200 disabled:opacity-40"
        >
          {saving && <Loader2 size={12} className="animate-spin" />} Save &amp; render
        </button>
      </header>
      {error && <p className="bg-red-500/10 px-4 py-2 text-xs text-red-300">{error}</p>}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Preview */}
        <section className="flex min-h-0 flex-col items-center justify-center gap-3 bg-black/40 p-6 lg:w-[44%]">
          <div className={cn("relative overflow-hidden rounded-2xl bg-black shadow-2xl ring-1 ring-white/10", vertical ? "aspect-[9/16] h-[min(62vh,640px)]" : "aspect-video w-full max-w-xl")}>
            <video
              ref={video}
              src={`/api/analyses/${analysisId}/files/source.mp4#t=${start}`}
              preload="metadata"
              playsInline
              onTimeUpdate={onTime}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onClick={togglePlay}
              className={cn("h-full w-full cursor-pointer", vertical && layoutNow?.mode !== "fit" ? "object-cover" : "object-contain")}
              style={vertical && layoutNow?.mode === "fill" ? { objectPosition: `${layoutNow.focusX}% 50%` } : undefined}
            />
            {brollNow &&
              (isBrollVideo(brollNow.file) ? (
                <video key={brollNow.file} src={fileUrl(brollNow.file)} muted autoPlay loop playsInline className="pointer-events-none absolute inset-0 h-full w-full object-cover" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- a local, already-sized upload
                <img src={fileUrl(brollNow.file)} alt="B-roll" className="pointer-events-none absolute inset-0 h-full w-full object-cover" />
              ))}
            {!playing && (
              <button onClick={togglePlay} className="absolute inset-0 m-auto flex h-14 w-14 items-center justify-center rounded-full bg-white/90 text-zinc-900 shadow-lg" aria-label="Play">
                <Play size={22} className="ml-1" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-3 text-[11px] text-zinc-500">
            <div className="flex rounded-lg bg-white/[0.05] p-0.5">
              {[
                [true, "9:16"],
                [false, "Original"],
              ].map(([v, label]) => (
                <button key={String(label)} onClick={() => setVertical(v as boolean)} className={cn("rounded-md px-2.5 py-1", vertical === v ? "bg-white/15 text-white" : "hover:text-zinc-300")}>
                  {label}
                </button>
              ))}
            </div>
            <span>Preview skips cuts · hook, pause trimming &amp; speaker framing appear after rendering</span>
          </div>
        </section>

        {/* Editing panel */}
        <section className="flex min-h-0 flex-1 flex-col border-white/[0.08] lg:border-l">
          <nav className="flex shrink-0 gap-1 border-b border-white/[0.08] px-4 pt-3">
            {(
              [
                ["ai", "Ask AI"],
                ["transcript", "Transcript"],
                ["options", "Options"],
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn("-mb-px flex items-center gap-1.5 border-b-2 px-3 pb-2.5 text-sm transition", tab === t ? "border-white text-white" : "border-transparent text-zinc-500 hover:text-zinc-300")}
              >
                {t === "ai" && <Sparkles size={14} />} {label}
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {words === null ? (
              <Loader2 size={18} className="animate-spin text-zinc-500" />
            ) : tab !== "options" && !all.length ? (
              <p className="text-sm text-zinc-500">This clip has no transcript yet. Render it once, then reopen the editor.</p>
            ) : tab === "ai" ? (
              <div className="mx-auto flex h-full max-w-xl flex-col">
                <div className="flex-1 space-y-3">
                  {!chat.length && (
                    <div className="pt-6 text-center">
                      <Sparkles className="mx-auto text-zinc-600" size={28} />
                      <p className="mt-3 text-sm text-zinc-300">Tell the AI what to change</p>
                      <p className="mt-1 text-xs text-zinc-500">It edits the clip; you can undo anything or fine-tune it in Transcript.</p>
                      <div className="mt-5 flex flex-wrap justify-center gap-2">
                        {SUGGESTIONS.map((s) => (
                          <button key={s} className={chip} onClick={() => askAi(s)} disabled={thinking}>
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {chat.map((m, i) => (
                    <div key={i} className={cn("flex", m.who === "you" ? "justify-end" : "justify-start")}>
                      <p className={cn("max-w-[85%] rounded-2xl px-3.5 py-2 text-sm", m.who === "you" ? "bg-white text-zinc-900" : "bg-white/[0.06] text-zinc-200")}>{m.text}</p>
                    </div>
                  ))}
                  {thinking && (
                    <p className="flex items-center gap-2 text-xs text-zinc-500">
                      <Loader2 size={12} className="animate-spin" /> Editing…
                    </p>
                  )}
                  <div ref={chatEnd} />
                </div>
                <form
                  className="sticky bottom-0 mt-4 flex items-center gap-2 rounded-2xl bg-zinc-900 p-1.5 ring-1 ring-white/10 focus-within:ring-white/30"
                  onSubmit={(e) => {
                    e.preventDefault();
                    askAi(ask);
                  }}
                >
                  <input
                    value={ask}
                    onChange={(e) => setAsk(e.target.value)}
                    placeholder="e.g. cut the part about school, make it 40 seconds"
                    aria-label="What should the AI change?"
                    className="min-w-0 flex-1 bg-transparent px-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
                  />
                  <button disabled={!ask.trim() || thinking} className="flex h-8 w-8 items-center justify-center rounded-full btn-glow disabled:opacity-30" aria-label="Send">
                    <Send size={14} />
                  </button>
                </form>
              </div>
            ) : tab === "transcript" ? (
              <>
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <button className={chip} disabled={!fillerRanges.length} onClick={() => change({ ...edit, removed: [...removed, ...fillerRanges] })}>
                    <Wand2 size={12} className="mr-1 inline" /> Remove filler words ({fillerRanges.length})
                  </button>
                  <button className={chip} disabled={!silenceRanges.length} onClick={() => change({ ...edit, removed: [...removed, ...silenceRanges] })}>
                    <Wand2 size={12} className="mr-1 inline" /> Remove silences ({silenceRanges.length})
                  </button>
                </div>
                <input
                  ref={picker}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void addImage(f);
                  }}
                />
                {broll.length > 0 && (
                  <div className="mb-4 space-y-1.5">
                    <p className="text-[11px] uppercase tracking-wide text-zinc-500">Pictures and videos (B-roll)</p>
                    {broll.map((b, i) => (
                      <div key={`${b.file}-${i}`} className="flex items-center gap-3 rounded-xl glass p-1.5 ">
                        {isBrollVideo(b.file) ? (
                          <video src={fileUrl(b.file)} muted preload="metadata" className="h-12 w-7 rounded-md object-cover" />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element -- a local upload
                          <img src={fileUrl(b.file)} alt="" className="h-12 w-7 rounded-md object-cover" />
                        )}
                        <button className="flex-1 text-left text-xs tabular-nums text-zinc-300 hover:text-white" onClick={() => seek(b.fromSeconds)}>
                          {clock(Math.max(0, b.fromSeconds - start))} – {clock(Math.max(0, b.toSeconds - start))}
                        </button>
                        <button
                          className="rounded-lg p-2 text-zinc-500 transition hover:bg-red-500/15 hover:text-red-300"
                          aria-label="Remove B-roll"
                          onClick={() => change({ ...edit, broll: broll.filter((_, k) => k !== i) })}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className={cn("sticky top-0 z-10 -mx-2 mb-3 flex flex-wrap items-center gap-1 rounded-xl bg-zinc-900/95 p-1.5 ring-1 ring-white/10 backdrop-blur transition", selRange ? "opacity-100" : "pointer-events-none opacity-40")}>
                  <span className="px-2 text-[11px] text-zinc-500">{selWords.length ? `${selWords.length} word${selWords.length > 1 ? "s" : ""}` : "Select words"}</span>
                  <button className={ghost} onClick={toggleRemove}>
                    {selRemoved ? "Restore" : "Cut"}
                  </button>
                  <button
                    className={ghost}
                    disabled={uploading}
                    onClick={() => {
                      brollFor.current = selRange;
                      picker.current?.click();
                    }}
                    title="Show your own picture or video full-screen over these words"
                  >
                    {uploading ? <Loader2 size={12} className="mr-1 inline animate-spin" /> : <ImagePlus size={12} className="mr-1 inline" />}
                    Add B-roll
                  </button>
                  <button className={ghost} onClick={() => selRange && push({ start: selRange[0] - 0.05 })}>
                    Start here
                  </button>
                  <button className={ghost} onClick={() => selRange && push({ end: selRange[1] + 0.15 })}>
                    End here
                  </button>
                  <select
                    className="rounded-lg bg-transparent px-2 py-1.5 text-xs text-zinc-300 hover:bg-white/[0.08]"
                    value=""
                    onChange={(e) => selRange && change(layoutFor(selRange, e.target.value as LayoutOverride["mode"] | "auto"))}
                    aria-label="Framing for the selected words"
                  >
                    <option value="" disabled>
                      Framing…
                    </option>
                    <option value="auto">Automatic</option>
                    <option value="fill">Close-up</option>
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
                      <input
                        value={fixing}
                        onChange={(e) => setFixing(e.target.value)}
                        placeholder="Fix spelling"
                        aria-label="Fix spelling"
                        className="w-28 rounded-lg bg-white/[0.06] px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:ring-1 focus:ring-white/30"
                      />
                      <button className={ghost} disabled={!fixing.trim()}>
                        Fix
                      </button>
                    </form>
                  )}
                </div>
                <p className="mb-3 text-[11px] text-zinc-600">Click a word to jump there; shift-click to select a stretch.</p>
                <div className="space-y-3 text-[15px] leading-8">
                  {sentences.map((s) => (
                    <p key={s.from}>
                      {all.slice(s.from, s.to + 1).map((w, k) => {
                        const i = s.from + k;
                        const out = !inClip(w);
                        const cut = isCut(w, removed);
                        const picked = sel && i >= Math.min(...sel) && i <= Math.max(...sel);
                        const live = now >= w.start && now < w.end;
                        return (
                          <span
                            key={w.ms}
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              setSel(e.shiftKey && sel ? [sel[0], i] : [i, i]);
                              setFixing("");
                              seek(w.start);
                            }}
                            onKeyDown={(e) => e.key === "Enter" && (setSel([i, i]), seek(w.start))}
                            className={cn(
                              "cursor-pointer rounded px-[2px] py-0.5 transition-colors",
                              picked ? "bg-sky-500/40 text-white" : live ? "bg-white/20 text-white" : "hover:bg-white/10",
                              cut ? "text-red-400/60 line-through" : out ? "text-zinc-700" : isFiller(w.text) ? "text-amber-300/80" : "text-zinc-200"
                            )}
                          >
                            {fixes.get(w.ms) ?? w.text.trim()}{" "}
                          </span>
                        );
                      })}
                    </p>
                  ))}
                </div>
              </>
            ) : (
              <div className="max-w-xl space-y-6">
                {[
                  ["Hook-first opening", "Plays the strongest line first as a teaser", edit.hook !== false, (v: boolean) => change({ ...edit, hook: v }), clip.hookStartSeconds === undefined],
                  ["Shorten long pauses", "Trims silences over 0.8 s when rendering", edit.trimPauses !== false, (v: boolean) => change({ ...edit, trimPauses: v }), false],
                  ["Captions", "Word-by-word captions on the clip", edit.captionStyle !== null, (v: boolean) => change({ ...edit, captionStyle: v ? undefined : null }), false],
                ].map(([label, hint, on, set, off]) => (
                  <label key={label as string} className={cn("flex cursor-pointer items-start justify-between gap-4", off && "cursor-not-allowed opacity-40")}>
                    <span>
                      <span className="block text-sm text-zinc-100">{label as string}</span>
                      <span className="block text-xs text-zinc-500">{off ? "No hook was picked for this clip" : (hint as string)}</span>
                    </span>
                    <input type="checkbox" className="mt-1 h-4 w-4 accent-white" checked={(on as boolean) && !off} disabled={off as boolean} onChange={(e) => (set as (v: boolean) => void)(e.target.checked)} />
                  </label>
                ))}
                {edit.captionStyle !== null && (
                  <div className="border-t border-white/[0.08] pt-5">
                    <label className="mb-3 flex cursor-pointer items-center justify-between">
                      <span className="text-sm text-zinc-100">Own caption style for this clip</span>
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-white"
                        checked={edit.captionStyle !== undefined}
                        onChange={(e) => change({ ...edit, captionStyle: e.target.checked ? DEFAULT_CAPTION_STYLE : undefined })}
                      />
                    </label>
                    {edit.captionStyle && <CaptionStylePicker style={edit.captionStyle} onChange={(s) => change({ ...edit, captionStyle: s })} />}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Timeline */}
      <footer className="flex h-16 shrink-0 items-center gap-3 border-t border-white/[0.08] px-4">
        <button onClick={togglePlay} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-zinc-900" aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}
        </button>
        <span className="w-24 shrink-0 text-[11px] tabular-nums text-zinc-500">
          {clock(Math.max(0, now - start))} / {clock(end - start)}
        </span>
        <div
          className="relative h-9 flex-1 cursor-pointer overflow-hidden rounded-lg bg-white/[0.06]"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            seek(start + ((e.clientX - r.left) / r.width) * (end - start));
          }}
          role="slider"
          aria-label="Timeline"
          aria-valuemin={0}
          aria-valuemax={Math.round(end - start)}
          aria-valuenow={Math.round(now - start)}
        >
          {sentences.map((s) => {
            const a = all[s.from].start;
            const b = all[s.to].end;
            return b > start && a < end ? <div key={s.from} className="absolute inset-y-2 rounded-sm bg-white/[0.12]" style={{ left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` }} /> : null;
          })}
          {removed.map(([a, b], i) => (
            <div key={i} className="absolute inset-y-0 bg-red-500/35" style={{ left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` }} />
          ))}
          {(edit.layout ?? []).map((l, i) => (
            <div key={i} className="absolute bottom-0 h-1 bg-sky-400" style={{ left: pct(l.fromSeconds), width: `calc(${pct(l.toSeconds)} - ${pct(l.fromSeconds)})` }} />
          ))}
          {broll.map((b, i) => (
            <div key={`b${i}`} className="absolute top-0 h-1 bg-emerald-400" style={{ left: pct(b.fromSeconds), width: `calc(${pct(b.toSeconds)} - ${pct(b.fromSeconds)})` }} />
          ))}
          <div className="absolute inset-y-0 w-0.5 bg-white" style={{ left: pct(now) }} />
        </div>
      </footer>
    </div>
  );
}
