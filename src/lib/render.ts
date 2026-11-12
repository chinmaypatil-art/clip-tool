import path from "path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition, openBrowser, type HeadlessBrowser } from "@remotion/renderer";
import type { TikTokPage } from "@remotion/captions";
import type { FramingSegment } from "../../remotion/types";
import { createLimiter } from "./limit";
import { processSingleton } from "./processState";

export class RenderError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "RenderError";
  }
}

const REMOTION_ENTRY = path.join(process.cwd(), "remotion", "index.ts");
const COMPOSITION_ID = "clip-classic";
const RENDER_CONCURRENCY = process.env.RENDER_CONCURRENCY ?? "75%";
// Each render already uses most CPU threads, so renders run one after another
// (server-wide, across jobs and Compare). Five at once took 8-13 min each and
// some timed out starting Chrome; queued, each gets the whole machine.
const renderSlot = processSingleton("renderSlot", () => createLimiter(Math.max(1, Number(process.env.RENDER_SLOTS ?? 1))));

// A headless Chromium launch (~1-2s) was previously paid on every single
// renderClip() call (5x per job). Reusing one instance across all clips in
// all jobs for the life of the server process removes that repeated cost.
let browserPromise: Promise<HeadlessBrowser> | null = null;

async function ensureBrowser(): Promise<HeadlessBrowser> {
  if (!browserPromise) {
    browserPromise = openBrowser("chrome").catch((err) => {
      browserPromise = null; // allow retry on next call
      throw err;
    });
  }
  return browserPromise;
}

/**
 * Bundles the Remotion project once per job, with the job's storage directory
 * as the publicDir — so staticFile('source.mp4') resolves to the job's actual
 * source video without us needing to guess at local-file-path support in
 * OffthreadVideo (an undocumented behavior we chose not to rely on).
 */
export async function bundleForJob(jobDir: string): Promise<string> {
  try {
    return await bundle({
      entryPoint: REMOTION_ENTRY,
      publicDir: jobDir,
      onProgress: () => {},
    });
  } catch (err) {
    throw new RenderError(`Failed to bundle Remotion project: ${describeError(err)}`, err);
  }
}

export interface RenderClipInput {
  serveUrl: string;
  outputPath: string;
  videoFileName: string;
  trimStartSeconds: number;
  durationSeconds: number;
  title: string;
  captionPages: TikTokPage[];
  /** Per-shot crop from analyzeFraming(); empty letterboxes the whole clip. */
  framing: FramingSegment[];
  onProgress?: (progress: number) => void;
}

export function renderClip(input: RenderClipInput): Promise<void> {
  return renderSlot(() => renderClipNow(input));
}

async function renderClipNow(input: RenderClipInput): Promise<void> {
  const inputProps = {
    videoFileName: input.videoFileName,
    trimStartSeconds: input.trimStartSeconds,
    durationSeconds: input.durationSeconds,
    title: input.title,
    captionPages: input.captionPages,
    framing: input.framing,
  };

  const puppeteerInstance = await ensureBrowser();

  let composition;
  try {
    composition = await selectComposition({
      serveUrl: input.serveUrl,
      id: COMPOSITION_ID,
      inputProps,
      puppeteerInstance,
    });
  } catch (err) {
    throw new RenderError(`Failed to resolve Remotion composition "${COMPOSITION_ID}": ${describeError(err)}`, err);
  }

  try {
    await renderMedia({
      composition,
      serveUrl: input.serveUrl,
      codec: "h264",
      // Default x264 preset is "medium"; veryfast encodes several times
      // quicker at a slightly larger file — visually identical at 1080x1920.
      x264Preset: "veryfast",
      // Remotion's default uses half the CPU threads; frame capture is the
      // render bottleneck and scales with workers, so give it more.
      concurrency: RENDER_CONCURRENCY,
      outputLocation: input.outputPath,
      inputProps,
      overwrite: true,
      puppeteerInstance,
      // Default is 30s, which we saw trip under real load (multiple renders
      // competing for CPU on this machine caused the root component's initial
      // asset load to exceed it). 120s gives real headroom without masking a
      // genuinely broken composition.
      timeoutInMilliseconds: 120_000,
      onProgress: ({ progress }) => input.onProgress?.(progress),
    });
  } catch (err) {
    throw new RenderError(`Remotion render failed for "${input.outputPath}": ${describeError(err)}`, err);
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
