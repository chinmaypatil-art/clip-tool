/**
 * User-selectable clip length presets. Shared by the submit form (client) and
 * the pipeline (server), so keep this file free of Node-only imports.
 */
export const CLIP_LENGTH_PRESETS = {
  short: { label: "Short", minSeconds: 20, maxSeconds: 35 },
  medium: { label: "Medium", minSeconds: 35, maxSeconds: 60 },
  long: { label: "Long", minSeconds: 60, maxSeconds: 120 },
  xlong: { label: "Extra long", minSeconds: 120, maxSeconds: 180 },
} as const;

export type ClipLengthPreset = keyof typeof CLIP_LENGTH_PRESETS;

export interface ClipLengthRange {
  minSeconds: number;
  maxSeconds: number;
}

export const DEFAULT_CLIP_LENGTH: ClipLengthPreset = "medium";

export function isClipLengthPreset(value: unknown): value is ClipLengthPreset {
  return typeof value === "string" && value in CLIP_LENGTH_PRESETS;
}

export function clipLengthRange(preset: ClipLengthPreset | undefined): ClipLengthRange {
  const { minSeconds, maxSeconds } = CLIP_LENGTH_PRESETS[preset ?? DEFAULT_CLIP_LENGTH];
  return { minSeconds, maxSeconds };
}
