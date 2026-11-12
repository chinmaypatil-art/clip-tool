import { z } from "zod";

const tikTokTokenSchema = z.object({
  text: z.string(),
  fromMs: z.number(),
  toMs: z.number(),
  pageBreakAfter: z.boolean().optional(),
});

const tikTokPageSchema = z.object({
  text: z.string(),
  startMs: z.number(),
  tokens: z.array(tikTokTokenSchema),
  durationMs: z.number(),
});

/** A person in a "split" shot: face centre and face width, as fractions of the source frame. */
const splitPersonSchema = z.object({
  cx: z.number(),
  cy: z.number(),
  w: z.number(),
});

/**
 * How one shot of the clip is framed in the vertical canvas (see
 * src/lib/framing.ts): "fill" crops the source to fill the canvas, centred via
 * focusX (CSS object-position x, 0-100); "split" stacks two people (top and
 * bottom halves) when they're too far apart for one crop; "fit" shows the
 * whole frame letterboxed.
 */
const framingSegmentSchema = z.object({
  fromSeconds: z.number(),
  toSeconds: z.number(),
  mode: z.enum(["fill", "fit", "split"]),
  focusX: z.number(),
  /** Only for "split": [top, bottom] people. */
  people: z.array(splitPersonSchema).optional(),
  /** Only for "split": source width / height. */
  sourceAspect: z.number().optional(),
});

export type FramingSegment = z.infer<typeof framingSegmentSchema>;

export const clipTemplateSchema = z.object({
  /** Filename inside the bundle's publicDir (resolved via staticFile()). */
  videoFileName: z.string(),
  trimStartSeconds: z.number(),
  durationSeconds: z.number(),
  title: z.string(),
  captionPages: z.array(tikTokPageSchema),
  /** Per-shot framing; empty means letterbox the whole clip. */
  framing: z.array(framingSegmentSchema).default([]),
});

export type ClipTemplateProps = z.input<typeof clipTemplateSchema>;

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;
export const OUTPUT_ASPECT = WIDTH / HEIGHT;
