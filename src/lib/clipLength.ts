/**
 * User-selectable clip length presets. Shared by the submit form (client) and
 * the pipeline (server), so keep this file free of Node-only imports.
 */
export const CLIP_LENGTH_PRESETS = {
  short: { label: "1-2 min", minSeconds: 60, maxSeconds: 120 },
  medium: { label: "2-3 min", minSeconds: 120, maxSeconds: 180 },
  long: { label: "3-4 min", minSeconds: 180, maxSeconds: 240 },
} as const;

export type ClipLengthPreset = keyof typeof CLIP_LENGTH_PRESETS;

export interface ClipLengthRange {
  minSeconds: number;
  maxSeconds: number;
}

export const DEFAULT_CLIP_LENGTH: ClipLengthPreset = "short";

export function isClipLengthPreset(value: unknown): value is ClipLengthPreset {
  return typeof value === "string" && value in CLIP_LENGTH_PRESETS;
}

export function clipLengthRange(preset: ClipLengthPreset | undefined): ClipLengthRange {
  const { minSeconds, maxSeconds } = CLIP_LENGTH_PRESETS[preset ?? DEFAULT_CLIP_LENGTH];
  return { minSeconds, maxSeconds };
}
