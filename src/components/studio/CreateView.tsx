"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, ChevronDown, Film, Link2, Loader2, Upload, X } from "lucide-react";
import { CLIP_COUNT_MAX, CLIP_COUNT_MIN, CLIP_LENGTH_PRESETS, DEFAULT_CLIP_COUNT, DEFAULT_CLIP_LENGTH, parseClipCount, type ClipLengthPreset } from "@/lib/clipLength";
import { DEFAULT_CAPTION_STYLE, parseCaptionStyle, type CaptionStyle } from "@/lib/captionStyle";
import { CaptionStylePicker } from "./CaptionStylePicker";
import { cn } from "./format";

const SETTINGS_KEY = "clip-settings";

interface Settings {
  clipLength: ClipLengthPreset;
  clipCount: number;
  captions: boolean;
  captionStyle: CaptionStyle;
  /** "auto": Gemma when there is speech, else Claude. "claude": Claude always. */
  picker: "auto" | "claude";
  language: Language;
}

// What the video's speech is in. Auto lets whisper guess, which can mistake
// noise (sizzling, crowds) for Hindi.
const LANGUAGES = [
  ["auto", "Auto"],
  ["en", "English"],
  ["hi", "Hindi"],
  ["mr", "Marathi"],
] as const;
type Language = (typeof LANGUAGES)[number][0];

const DEFAULT_SETTINGS: Settings = { clipLength: DEFAULT_CLIP_LENGTH, clipCount: DEFAULT_CLIP_COUNT, captions: true, captionStyle: DEFAULT_CAPTION_STYLE, picker: "auto", language: "auto" };

function loadSettings(): Settings {
  const fallback = DEFAULT_SETTINGS;
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
    if (!raw) return fallback;
    return {
      clipLength: raw.clipLength in CLIP_LENGTH_PRESETS ? raw.clipLength : fallback.clipLength,
      clipCount: parseClipCount(raw.clipCount),
      captions: raw.captions !== false,
      captionStyle: parseCaptionStyle(raw.captionStyle),
      // No picker choice any more: Clipwise decides (a saved "claude" is ignored).
      picker: "auto",
      language: LANGUAGES.some(([k]) => k === raw.language) ? raw.language : "auto",
    };
  } catch {
    return fallback;
  }
}

/** Link or upload in, plus the few choices that matter; everything else is automatic. */
export function CreateView({ onStarted }: { onStarted: (analysisId: string) => void }) {
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [styleOpen, setStyleOpen] = useState(false);
  // Per video, so not remembered with the other settings.
  const [focus, setFocus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Remember the last choices; read after mount so server and client HTML match.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setSettings(loadSettings()), []);
  const update = (patch: Partial<Settings>) =>
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });

  const ready = Boolean(file) || /^https?:\/\/\S+$/i.test(url.trim());

  const submit = async () => {
    if (!ready || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const body = { oneClick: true, ...settings, focus: focus.trim() };
      let res: Response;
      if (file) {
        res = await fetch("/api/analyses", {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-File-Name": encodeURIComponent(file.name),
            "X-Settings": encodeURIComponent(JSON.stringify(body)),
          },
          body: file,
        });
      } else {
        res = await fetch("/api/analyses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, url: url.trim() }),
        });
      }
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.analysisId) throw new Error(data?.error ?? "Couldn't start. Try again.");
      setUrl("");
      setFile(null);
      setFocus("");
      onStarted(data.analysisId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 pb-24 pt-16 sm:pt-24">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mb-10 text-center">
        <h1 className="text-4xl font-semibold tracking-[-0.03em] text-white sm:text-6xl">Clipwise</h1>
        <p className="mt-4 text-balance text-sm text-zinc-400 sm:text-base">Clip anything. Paste a YouTube link or upload a video, and render the picks you like.</p>
      </motion.div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) setFile(f);
        }}
        className={cn(
          "glass-edge rounded-[22px] p-2"
        )}
        data-active={dragging}
      >
        <div className="flex items-center gap-2">
          {file ? (
            <div className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5">
              <Film size={16} className="shrink-0 text-zinc-400" />
              <span className="truncate text-sm text-zinc-200">{file.name}</span>
              <span className="shrink-0 text-xs text-zinc-500">{(file.size / 1e6).toFixed(0)} MB</span>
              <button onClick={() => setFile(null)} className="ml-auto rounded p-1 text-zinc-500 hover:text-zinc-200" title="Remove">
                <X size={14} />
              </button>
            </div>
          ) : (
            <label className="flex min-w-0 flex-1 items-center gap-2.5 px-3">
              <Link2 size={16} className="shrink-0 text-zinc-500" />
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="Paste a YouTube link…"
                className="w-full bg-transparent py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
              />
            </label>
          )}
          {!file && (
            <button
              onClick={() => fileInput.current?.click()}
              className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-2.5 text-sm text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
              title="Upload a video file"
            >
              <Upload size={15} /> <span className="hidden sm:inline">Upload</span>
            </button>
          )}
          <button
            onClick={submit}
            disabled={!ready || submitting}
            className="btn-glow flex shrink-0 items-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-medium disabled:opacity-35"
          >
            {submitting ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
            Make clips
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="video/*,audio/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setFile(f);
              e.target.value = "";
            }}
          />
        </div>
      </div>
      <input
        value={focus}
        onChange={(e) => setFocus(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        maxLength={120}
        aria-label="What to look for (optional)"
        placeholder="What to look for (optional): e.g. funny moments, money advice"
        className="glass mt-3 w-full rounded-full px-5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-400/40 focus:outline-none"
      />
      {error && <p className="mt-3 text-center text-sm text-red-400">{error}</p>}

      <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-zinc-500">Length</span>
          <div className="glass flex rounded-full p-0.5">
            {(Object.entries(CLIP_LENGTH_PRESETS) as [ClipLengthPreset, (typeof CLIP_LENGTH_PRESETS)[ClipLengthPreset]][]).map(([key, p]) => (
              <button
                key={key}
                onClick={() => update({ clipLength: key })}
                className={cn(
                  "rounded-full px-3 py-1 text-xs transition-colors",
                  settings.clipLength === key ? "seg-on" : "text-zinc-400 hover:text-zinc-200"
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2">
          <span className="text-zinc-500">Clips</span>
          <select
            value={settings.clipCount}
            onChange={(e) => update({ clipCount: parseClipCount(e.target.value) })}
            className="glass rounded-full px-3 py-1 text-xs text-white focus:outline-none"
          >
            {Array.from({ length: CLIP_COUNT_MAX - CLIP_COUNT_MIN + 1 }, (_, i) => CLIP_COUNT_MIN + i).map((n) => (
              <option key={n} value={n} className="bg-zinc-900">
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-zinc-500">Language</span>
          <select
            value={settings.language}
            onChange={(e) => update({ language: e.target.value as Language })}
            className="glass rounded-full px-3 py-1 text-xs text-white focus:outline-none"
          >
            {LANGUAGES.map(([key, label]) => (
              <option key={key} value={key} className="bg-zinc-900">
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2">
          <span className="text-zinc-500">Captions</span>
          <button
            role="switch"
            aria-checked={settings.captions}
            onClick={() => update({ captions: !settings.captions })}
            className={cn("relative h-5 w-9 rounded-full transition-colors", settings.captions ? "seg-on" : "bg-white/15")}
          >
            <span
              className={cn(
                "absolute top-0.5 h-4 w-4 rounded-full transition-all",
                settings.captions ? "left-[18px] bg-white" : "left-0.5 bg-zinc-400"
              )}
            />
          </button>
        </div>
        {settings.captions && (
          <button
            onClick={() => setStyleOpen((o) => !o)}
            className="flex items-center gap-1 text-xs text-zinc-400 transition hover:text-zinc-200"
          >
            Style <ChevronDown size={13} className={cn("transition", styleOpen && "rotate-180")} />
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {settings.captions && styleOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-6 rounded-2xl glass p-5">
              <CaptionStylePicker style={settings.captionStyle} onChange={(captionStyle) => update({ captionStyle })} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
