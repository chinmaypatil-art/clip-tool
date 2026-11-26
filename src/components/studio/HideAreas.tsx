"use client";

import { useRef, useState } from "react";
import { EyeOff, Loader2, Trash2 } from "lucide-react";
import type { HideArea } from "@/lib/analyses";
import { cn } from "./format";

// Must match cutClip in media.ts: a thin box on the top or bottom edge is cropped away, anything else blurred.
const EDGE = 0.03;
const MAX_EDGE_CROP = 0.12;
const isTopCrop = (b: HideArea) => b.y <= EDGE && b.y + b.h <= MAX_EDGE_CROP;
const isBottomCrop = (b: HideArea) => b.y + b.h >= 1 - EDGE && b.h <= MAX_EDGE_CROP;

const PREVIEW_W = 180;
const PREVIEW_H = 320;

/**
 * "Hide area": the user draws boxes over a stream's logo or subscriber counter
 * once per video. Clips rendered afterwards crop or blur them; the source file
 * is never changed, and removing a box undoes it for the next render.
 */
export function HideAreas({ analysisId, saved, onSaved }: { analysisId: string; saved: HideArea[]; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [boxes, setBoxes] = useState<HideArea[]>(saved);
  const [drawing, setDrawing] = useState<HideArea | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [at, setAt] = useState(0);
  const [duration, setDuration] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const start = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const src = `/api/analyses/${analysisId}/files/source.mp4`;
  const changed = JSON.stringify(boxes) !== JSON.stringify(saved);

  const point = (e: React.PointerEvent) => {
    const r = frame.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const boxFrom = (a: { x: number; y: number }, b: { x: number; y: number }): HideArea => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  });

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/analyses/${analysisId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hideAreas: boxes }),
      });
      if (!res.ok) throw new Error();
      onSaved();
    } catch {
      setError("Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mb-6 flex items-center gap-2 rounded-xl bg-white/[0.04] px-3 py-2 text-xs text-zinc-300 ring-1 ring-white/[0.08] transition hover:bg-white/[0.08]"
      >
        <EyeOff size={13} /> Hide area{saved.length > 0 && ` (${saved.length})`}
        <span className="text-zinc-500">· remove a logo or counter from the clips</span>
      </button>
    );
  }

  // The 9:16 preview, centred like a clip with no face to follow.
  const top = Math.max(0, ...boxes.filter(isTopCrop).map((b) => b.y + b.h));
  const bottom = Math.max(0, ...boxes.filter(isBottomCrop).map((b) => 1 - b.y));
  const p = size && (() => {
    const s = Math.max(PREVIEW_W / size.w, PREVIEW_H / (size.h * (1 - top - bottom)));
    const w = size.w * s;
    const h = size.h * s;
    return { w, h, left: (PREVIEW_W - w) / 2, top: (PREVIEW_H - h * (1 - top - bottom)) / 2 - top * h };
  })();

  return (
    <div className="mb-8 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-zinc-200">Hide area</p>
        <button onClick={() => setOpen(false)} className="text-xs text-zinc-500 hover:text-zinc-300">
          Close
        </button>
      </div>
      <p className="mb-3 text-xs text-zinc-500">
        Drag a box over the logo or counter. A thin box on the top or bottom edge is cut off; anything else is blurred. It applies to clips you
        render from now on. It can&apos;t follow overlays that move, pop up, or change between scenes.
      </p>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <div
            ref={frame}
            className="relative w-full touch-none select-none overflow-hidden rounded-lg bg-black"
            style={{ aspectRatio: size ? `${size.w} / ${size.h}` : "16 / 9", cursor: "crosshair" }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              start.current = point(e);
              setDrawing(boxFrom(start.current, start.current));
            }}
            onPointerMove={(e) => start.current && setDrawing(boxFrom(start.current, point(e)))}
            onPointerUp={(e) => {
              const b = start.current && boxFrom(start.current, point(e));
              start.current = null;
              setDrawing(null);
              if (b && b.w > 0.01 && b.h > 0.01) setBoxes((all) => [...all, b].slice(0, 10));
            }}
          >
            <video
              src={`${src}#t=${at}`}
              preload="metadata"
              muted
              playsInline
              className="pointer-events-none h-full w-full"
              onLoadedMetadata={(e) => {
                setSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight });
                setDuration(e.currentTarget.duration);
              }}
            />
            {[...boxes, ...(drawing ? [drawing] : [])].map((b, i) => (
              <div
                key={i}
                className={cn("pointer-events-none absolute border-2", isTopCrop(b) || isBottomCrop(b) ? "border-amber-400 bg-amber-400/20" : "border-sky-400 bg-sky-400/20")}
                style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
              />
            ))}
          </div>
          {duration > 0 && (
            <input
              type="range"
              min={0}
              max={Math.floor(duration)}
              value={at}
              onChange={(e) => setAt(Number(e.target.value))}
              className="mt-2 w-full"
              aria-label="Look at another moment of the video"
            />
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {boxes.map((b, i) => (
              <span key={i} className="flex items-center gap-1.5 rounded-lg bg-white/[0.04] py-1 pl-2.5 pr-1 text-[11px] text-zinc-300 ring-1 ring-white/[0.08]">
                Box {i + 1} · {isTopCrop(b) || isBottomCrop(b) ? "cut off" : "blurred"}
                <button onClick={() => setBoxes(boxes.filter((_, k) => k !== i))} className="rounded p-1 text-zinc-500 hover:text-red-300" aria-label={`Remove box ${i + 1}`}>
                  <Trash2 size={11} />
                </button>
              </span>
            ))}
          </div>
        </div>
        <div className="shrink-0">
          <p className="mb-1.5 text-[11px] text-zinc-500">Preview (centred)</p>
          <div className="relative overflow-hidden rounded-lg bg-black" style={{ width: PREVIEW_W, height: PREVIEW_H }}>
            {p && (
              <>
                <video src={`${src}#t=${at}`} preload="metadata" muted playsInline className="absolute max-w-none" style={{ left: p.left, top: p.top, width: p.w, height: p.h }} />
                {boxes
                  .filter((b) => !isTopCrop(b) && !isBottomCrop(b))
                  .map((b, i) => (
                    <div
                      key={i}
                      className="absolute backdrop-blur-md"
                      style={{ left: p.left + b.x * p.w, top: p.top + b.y * p.h, width: b.w * p.w, height: b.h * p.h }}
                    />
                  ))}
              </>
            )}
          </div>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={save}
          disabled={!changed || saving}
          className="rounded-xl bg-white px-4 py-2 text-xs font-medium text-zinc-900 transition disabled:opacity-40"
        >
          {saving ? <Loader2 size={12} className="inline animate-spin" /> : "Save"}
        </button>
        {error && <span className="text-xs text-red-300">{error}</span>}
        {!changed && saved.length > 0 && <span className="text-xs text-zinc-500">Saved. Render a clip to see it.</span>}
      </div>
    </div>
  );
}
