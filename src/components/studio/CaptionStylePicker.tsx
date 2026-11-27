"use client";

import {
  CAPTION_BACKGROUNDS,
  CAPTION_FONTS,
  CAPTION_POSITIONS,
  CAPTION_PRESETS,
  CAPTION_SIZES,
  CAPTION_WORDS,
  type CaptionStyle,
} from "@/lib/captionStyle";
import { cn } from "./format";

const SAMPLE = ["this", "is", "how", "your", "captions", "look"];
const ACTIVE_WORD = 4;
const TEXT_COLORS = ["#FFFFFF", "#FFE34D", "#4ADE80", "#38BDF8", "#F472B6"];
const HIGHLIGHT_COLORS = ["#FFE34D", "#4ADE80", "#F87171", "#38BDF8", "#C084FC"];
const SIZE_LABELS = { s: "S", m: "M", l: "L", xl: "XL" } as const;

/** A 9:16 frame showing captions as they'll be burned in (same rules as CaptionsOverlay). */
export function CaptionPreview({ style, width = 168 }: { style: CaptionStyle | null; width?: number }) {
  const scale = width / 1080;
  const font = style ? CAPTION_FONTS[style.font] : null;
  const size = style ? CAPTION_SIZES[style.size] : 0;
  const words = style && style.words === "one" ? [SAMPLE[ACTIVE_WORD]] : style?.words === "few" ? SAMPLE.slice(3, 5) : SAMPLE;
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-xl bg-gradient-to-b from-zinc-700 via-zinc-800 to-zinc-900 ring-1 ring-white/10"
      style={{ width, height: (width * 16) / 9 }}
    >
      <div className="absolute inset-x-0 top-[22%] mx-auto h-[38%] w-[46%] rounded-full bg-zinc-600/40 blur-[2px]" />
      {style && font && (
        <div
          className="absolute inset-x-0 flex justify-center"
          style={{
            top: style.position === "top" ? 260 * scale : style.position === "middle" ? "50%" : undefined,
            bottom: style.position === "bottom" ? 380 * scale : undefined,
            transform: style.position === "middle" ? "translateY(-50%)" : undefined,
            padding: `0 ${48 * scale}px`,
          }}
        >
          <div
            className="flex flex-wrap justify-center text-center"
            style={{
              gap: `0 ${14 * scale}px`,
              fontFamily: `"${font.family}", sans-serif`,
              fontWeight: font.weight,
              fontSize: size * scale,
              lineHeight: 1.25,
              ...(style.background === "box"
                ? { background: "rgba(0,0,0,0.75)", borderRadius: 16 * scale, padding: `${8 * scale}px ${20 * scale}px` }
                : {}),
            }}
          >
            {words.map((w, i) => {
              const active = style.highlight && w === SAMPLE[ACTIVE_WORD];
              return (
                <span
                  key={i}
                  style={{
                    color: active ? style.highlight! : style.color,
                    WebkitTextStroke: style.background === "outline" ? `${Math.max(3, size * 0.05) * scale}px black` : undefined,
                    paintOrder: "stroke fill",
                    textShadow: style.background === "shadow" ? `0 ${4 * scale}px ${8 * scale}px rgba(0,0,0,.85)` : undefined,
                    transform: active ? "scale(1.08)" : undefined,
                    display: "inline-block",
                  }}
                >
                  {style.uppercase ? w.toUpperCase() : w}
                </span>
              );
            })}
          </div>
        </div>
      )}
      {!style && (
        <span className="absolute inset-x-0 bottom-3 text-center text-[10px] text-zinc-400">No captions</span>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-zinc-500">{label}</span>
      <div className="flex flex-wrap justify-end gap-1">{children}</div>
    </div>
  );
}

function Chip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "rounded-md px-2 py-1 text-xs transition",
        active ? "seg-on" : "bg-white/[0.05] text-zinc-400 hover:bg-white/10 hover:text-zinc-200"
      )}
    >
      {children}
    </button>
  );
}

function Swatch({ color, active, onClick }: { color: string | null; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={color ?? "Off"}
      className={cn(
        "h-6 w-6 rounded-full ring-offset-2 ring-offset-zinc-900 transition",
        active ? "ring-2 ring-white" : "ring-1 ring-white/15 hover:ring-white/40"
      )}
      style={{ background: color ?? "repeating-linear-gradient(45deg,#3f3f46 0 3px,#18181b 3px 6px)" }}
    />
  );
}

/** Presets plus every option; the preview updates as you go. */
export function CaptionStylePicker({ style, onChange }: { style: CaptionStyle; onChange: (s: CaptionStyle) => void }) {
  const set = <K extends keyof CaptionStyle>(key: K, value: CaptionStyle[K]) => onChange({ ...style, [key]: value });
  const presetKey = Object.entries(CAPTION_PRESETS).find(([, p]) => JSON.stringify(p.style) === JSON.stringify(style))?.[0];

  return (
    <div className="flex flex-col gap-5 sm:flex-row">
      <CaptionPreview style={style} width={168} />
      <div className="min-w-0 flex-1 space-y-3">
        <div className="grid grid-cols-4 gap-1.5">
          {Object.entries(CAPTION_PRESETS).map(([key, p]) => (
            <button
              key={key}
              type="button"
              onClick={() => onChange(p.style)}
              className={cn(
                "rounded-lg border px-2 py-2 text-xs transition",
                presetKey === key ? "border-white/60 bg-white/10 text-white" : "border-white/10 text-zinc-400 hover:border-white/25 hover:text-zinc-200"
              )}
              style={{ fontFamily: `"${CAPTION_FONTS[p.style.font].family}"` }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <Row label="Font">
          <select
            value={style.font}
            onChange={(e) => set("font", e.target.value as CaptionStyle["font"])}
            className="rounded-md border border-white/10 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none"
            style={{ fontFamily: `"${CAPTION_FONTS[style.font].family}"` }}
          >
            {Object.entries(CAPTION_FONTS).map(([key, f]) => (
              <option key={key} value={key} style={{ fontFamily: `"${f.family}"` }}>
                {f.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Size">
          {(Object.keys(CAPTION_SIZES) as CaptionStyle["size"][]).map((k) => (
            <Chip key={k} active={style.size === k} onClick={() => set("size", k)}>
              {SIZE_LABELS[k]}
            </Chip>
          ))}
        </Row>
        <Row label="Text">
          {TEXT_COLORS.map((c) => (
            <Swatch key={c} color={c} active={style.color === c} onClick={() => set("color", c)} />
          ))}
        </Row>
        <Row label="Spoken word">
          <Swatch color={null} active={style.highlight === null} onClick={() => set("highlight", null)} />
          {HIGHLIGHT_COLORS.map((c) => (
            <Swatch key={c} color={c} active={style.highlight === c} onClick={() => set("highlight", c)} />
          ))}
        </Row>
        <Row label="Background">
          {Object.entries(CAPTION_BACKGROUNDS).map(([k, label]) => (
            <Chip key={k} active={style.background === k} onClick={() => set("background", k as CaptionStyle["background"])}>
              {label}
            </Chip>
          ))}
        </Row>
        <Row label="Position">
          {Object.entries(CAPTION_POSITIONS).map(([k, label]) => (
            <Chip key={k} active={style.position === k} onClick={() => set("position", k as CaptionStyle["position"])}>
              {label}
            </Chip>
          ))}
        </Row>
        <Row label="On screen">
          {Object.entries(CAPTION_WORDS).map(([k, label]) => (
            <Chip key={k} active={style.words === k} onClick={() => set("words", k as CaptionStyle["words"])}>
              {label}
            </Chip>
          ))}
        </Row>
        <Row label="Capitals">
          <Chip active={!style.uppercase} onClick={() => set("uppercase", false)}>
            Aa
          </Chip>
          <Chip active={style.uppercase} onClick={() => set("uppercase", true)}>
            AA
          </Chip>
        </Row>
      </div>
    </div>
  );
}
