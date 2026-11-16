/**
 * How burned-in captions look. Shared by the UI (picker + preview) and both
 * renderers (ffmpeg's ASS file, Remotion's CaptionsOverlay). Fonts are ones
 * Windows ships, so libass, Chrome and the browser preview all find them.
 */

export const CAPTION_FONTS = {
  arial: { label: "Arial", family: "Arial", weight: 800 },
  arialBlack: { label: "Arial Black", family: "Arial Black", weight: 900 },
  impact: { label: "Impact", family: "Impact", weight: 400 },
  segoe: { label: "Segoe UI", family: "Segoe UI", weight: 700 },
  verdana: { label: "Verdana", family: "Verdana", weight: 700 },
  georgia: { label: "Georgia", family: "Georgia", weight: 700 },
} as const;
export type CaptionFont = keyof typeof CAPTION_FONTS;

/** Font size in px on the 1080x1920 canvas. */
export const CAPTION_SIZES = { s: 60, m: 72, l: 84, xl: 96 } as const;
export type CaptionSize = keyof typeof CAPTION_SIZES;

export const CAPTION_BACKGROUNDS = { outline: "Outline", box: "Box", shadow: "Shadow" } as const;
export type CaptionBackground = keyof typeof CAPTION_BACKGROUNDS;

export const CAPTION_POSITIONS = { bottom: "Bottom", middle: "Middle", top: "Top" } as const;
export type CaptionPosition = keyof typeof CAPTION_POSITIONS;

/** How many words are on screen at once. */
export const CAPTION_WORDS = { one: "1 word", few: "Few words", line: "Full line" } as const;
export type CaptionWords = keyof typeof CAPTION_WORDS;

export interface CaptionStyle {
  font: CaptionFont;
  size: CaptionSize;
  /** #RRGGBB */
  color: string;
  /** Colour of the word being spoken; null turns highlighting off. */
  highlight: string | null;
  background: CaptionBackground;
  position: CaptionPosition;
  uppercase: boolean;
  words: CaptionWords;
}

export const CAPTION_PRESETS: Record<string, { label: string; style: CaptionStyle }> = {
  classic: {
    label: "Classic",
    style: { font: "arial", size: "m", color: "#FFFFFF", highlight: "#FFE34D", background: "outline", position: "bottom", uppercase: false, words: "line" },
  },
  bold: {
    label: "Bold",
    style: { font: "impact", size: "xl", color: "#FFFFFF", highlight: "#FFE34D", background: "outline", position: "middle", uppercase: true, words: "few" },
  },
  boxed: {
    label: "Boxed",
    style: { font: "segoe", size: "m", color: "#FFFFFF", highlight: "#4ADE80", background: "box", position: "bottom", uppercase: false, words: "few" },
  },
  minimal: {
    label: "Minimal",
    style: { font: "segoe", size: "s", color: "#FFFFFF", highlight: null, background: "shadow", position: "bottom", uppercase: false, words: "line" },
  },
};

export const DEFAULT_CAPTION_STYLE: CaptionStyle = CAPTION_PRESETS.classic.style;

/** Milliseconds within which tokens share a caption page, per CaptionWords. */
export const WORDS_COMBINE_MS: Record<CaptionWords, number> = { one: 0, few: 500, line: 1200 };

const HEX = /^#[0-9a-fA-F]{6}$/;
const pick = <T extends string>(value: unknown, options: Record<T, unknown>, fallback: T): T =>
  typeof value === "string" && value in options ? (value as T) : fallback;

/** A safe CaptionStyle from untrusted input; anything invalid falls back to the default. */
export function parseCaptionStyle(value: unknown): CaptionStyle {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const d = DEFAULT_CAPTION_STYLE;
  return {
    font: pick(v.font, CAPTION_FONTS, d.font),
    size: pick(v.size, CAPTION_SIZES, d.size),
    color: typeof v.color === "string" && HEX.test(v.color) ? v.color : d.color,
    highlight: v.highlight === null ? null : typeof v.highlight === "string" && HEX.test(v.highlight) ? v.highlight : d.highlight,
    background: pick(v.background, CAPTION_BACKGROUNDS, d.background),
    position: pick(v.position, CAPTION_POSITIONS, d.position),
    uppercase: typeof v.uppercase === "boolean" ? v.uppercase : d.uppercase,
    words: pick(v.words, CAPTION_WORDS, d.words),
  };
}
