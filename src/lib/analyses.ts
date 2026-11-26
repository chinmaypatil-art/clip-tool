import { randomUUID } from "crypto";
import type { ClipEdit } from "./clipEdit";
import { processSingleton } from "./processState";
import path from "path";
import { mkdir, readFile, writeFile, readdir, rename } from "fs/promises";
import type { TranscriptSegment } from "./transcript";
import type { NormalizedClip } from "./providers/types";
import type { Provider } from "./keystore";
import type { ClipLengthPreset } from "./clipLength";
import type { ClipReview } from "./review";
import type { CaptionStyle } from "./captionStyle";

export type AnalysisStatus = "extracting_transcript" | "ready" | "error";
export type RunStatus = "queued" | "running" | "done" | "error";
export type RenderStatus = "pending" | "rendering" | "done" | "error";

export interface AnalysisClip extends NormalizedClip {
  id: string;
  /** The model's own edges, kept when a reviewer corrects startSeconds/endSeconds. */
  modelStartSeconds?: number;
  modelEndSeconds?: number;
  review?: ClipReview;
  /** The edges the current render file was made with. */
  renderedStartSeconds?: number;
  renderedEndSeconds?: number;
  renderStatus: RenderStatus;
  renderFilename?: string;
  renderThumbnailFilename?: string;
  renderError?: string;
  /** Render button pressed; renders run one at a time, so it may wait in a queue. */
  renderQueuedAt?: number;
  /** Rendering itself began (after the queue). */
  renderStartedAt?: number;
  renderFinishedAt?: number;
  /** Renders ahead of this one in the shared queue (another video's clips), while it waits. */
  queueAhead?: number;
  /** The user's edits from the clip editor; applied on every render. */
  edit?: ClipEdit;
  /** Words of the last render (clip-relative ms), for the editor's transcript. */
  wordsFilename?: string;
}

export interface ModelRun {
  /** Jobs ahead in the one-at-a-time GPU queue (picking / Whisper) while this waits. */
  queueAhead?: number;
  id: string;
  provider: Provider;
  model: string;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  tokenUsage: { inputTokens?: number; outputTokens?: number } | null;
  keyLabel: string | null;
  attempts: number | null;
  error: string | null;
  promptVersion: string;
  clipLength?: ClipLengthPreset;
  clips: AnalysisClip[];
  rawResponse: unknown;
}

export interface HideArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Validates hide areas from the browser: up to 8 boxes inside the frame. */
export function parseHideAreas(raw: unknown): HideArea[] {
  if (!Array.isArray(raw)) return [];
  const f = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
  return raw
    .map((b) => (b && typeof b === "object" ? (b as Record<string, unknown>) : {}))
    .map((b) => ({ x: f(b.x), y: f(b.y), w: f(b.w), h: f(b.h) }))
    .filter((b): b is HideArea => b.x !== null && b.y !== null && b.w !== null && b.h !== null && b.w >= 0.05 && b.h >= 0.05)
    .map((b) => ({ ...b, w: Math.min(b.w, 1 - b.x), h: Math.min(b.h, 1 - b.y) }))
    .slice(0, 8);
}

export interface Analysis {
  /** Jobs ahead in the one-at-a-time GPU queue (picking / Whisper) while this waits. */
  queueAhead?: number;
  id: string;
  sourceLabel: string;
  sourceKind: "youtube" | "file";
  sourceUrl?: string;
  status: AnalysisStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  /** Stage timestamps (ms) for timing reports. */
  downloadedAt?: number;
  transcriptReadyAt?: number;
  videoDurationSeconds: number | null;
  transcript: { segments: TranscriptSegment[]; language: string; source: string } | null;
  runs: ModelRun[];
  /** source.mp4 was deleted after review, so clips can no longer be rendered. */
  sourceDeleted?: boolean;
  /** Parts of the frame to blur in every clip (a stream's logo, subscriber counter); fractions of the frame. */
  hideAreas?: HideArea[];
  /** Removed from history, but its reviews are kept as training data. */
  archived?: boolean;
  /** The video's own title (YouTube) or the uploaded file's name. */
  title?: string;
  /** Made by the one-click flow (link in, clips out) rather than Compare. */
  oneClick?: boolean;
  clipLength?: ClipLengthPreset;
  /** How many clips the one-click flow makes (3-10); unset means the default. */
  clipCount?: number;
  /** Caption look for this video's renders; null renders no captions. */
  captionStyle?: CaptionStyle | null;
  /** What the user asked the picker to look for ("funny moments"). */
  focus?: string;
  /** Too little speech for Gemma to pick from: waits for Claude to watch it over MCP. */
  waitingForClaude?: boolean;
  /** "claude": the user asked for Claude to pick, whatever the speech. */
  picker?: "claude";
}

const analyses = processSingleton("analyses", () => new Map<string, Analysis>());
export const ANALYSES_ROOT = path.join(process.cwd(), "storage", "analyses");

export function analysisDir(id: string): string {
  return path.join(ANALYSES_ROOT, id);
}

export async function ensureAnalysisDir(id: string): Promise<string> {
  const dir = analysisDir(id);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function createAnalysis(sourceLabel: string, sourceKind: "youtube" | "file", sourceUrl?: string): Analysis {
  const analysis: Analysis = {
    id: randomUUID(),
    sourceLabel,
    sourceKind,
    sourceUrl,
    status: "extracting_transcript",
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    videoDurationSeconds: null,
    transcript: null,
    runs: [],
  };
  analyses.set(analysis.id, analysis);
  persist(analysis);
  return analysis;
}

export function getAnalysis(id: string): Analysis | undefined {
  return analyses.get(id);
}

export async function loadAnalysis(id: string): Promise<Analysis | undefined> {
  const cached = analyses.get(id);
  if (cached) return cached;
  try {
    const raw = await readFile(path.join(analysisDir(id), "analysis.json"), "utf8");
    const analysis = JSON.parse(raw) as Analysis;
    // Loaded from disk means this process didn't start it: anything still
    // marked as running was cut off by a server restart and will never finish.
    let interrupted = false;
    for (const run of analysis.runs) {
      for (const clip of run.clips) {
        if (clip.renderStatus !== "rendering") continue;
        Object.assign(clip, { renderStatus: "error", renderError: "Stopped by a server restart. Click Try again." });
        interrupted = true;
      }
      if (run.status === "running" || run.status === "queued") {
        Object.assign(run, { status: "error", error: "Stopped by a server restart. Start the video again." });
        interrupted = true;
      }
    }
    if (analysis.status === "extracting_transcript") {
      Object.assign(analysis, { status: "error", error: "Stopped by a server restart. Start the video again." });
      interrupted = true;
    }
    analyses.set(id, analysis);
    // `next build` loads these files too (prerendering): it must never write
    // the live server's running jobs back to disk as stopped.
    if (interrupted && process.env.CLIPWISE_SERVER === "1") persist(analysis);
    return analysis;
  } catch {
    return undefined;
  }
}

export function updateAnalysis(id: string, patch: Partial<Analysis>): void {
  const analysis = analyses.get(id);
  if (!analysis) return;
  Object.assign(analysis, patch, { updatedAt: Date.now() });
  persist(analysis);
}

export function addRun(id: string, run: ModelRun): void {
  const analysis = analyses.get(id);
  if (!analysis) return;
  analysis.runs.push(run);
  analysis.updatedAt = Date.now();
  persist(analysis);
}

export function updateRun(id: string, runId: string, patch: Partial<ModelRun>): void {
  const analysis = analyses.get(id);
  if (!analysis) return;
  const run = analysis.runs.find((r) => r.id === runId);
  if (!run) return;
  Object.assign(run, patch);
  analysis.updatedAt = Date.now();
  persist(analysis);
}

export function updateRunClip(id: string, runId: string, clipId: string, patch: Partial<AnalysisClip>): void {
  const analysis = analyses.get(id);
  if (!analysis) return;
  const run = analysis.runs.find((r) => r.id === runId);
  const clip = run?.clips.find((c) => c.id === clipId);
  if (!clip) return;
  Object.assign(clip, patch);
  analysis.updatedAt = Date.now();
  persist(analysis);
}

export async function listAnalyses(): Promise<Analysis[]> {
  let entries: string[];
  try {
    entries = await readdir(ANALYSES_ROOT);
  } catch {
    return [];
  }
  const results: Analysis[] = [];
  for (const id of entries) {
    const a = await loadAnalysis(id);
    if (a) results.push(a);
  }
  results.sort((a, b) => b.createdAt - a.createdAt);
  return results;
}

export function forgetAnalysis(id: string): void {
  analyses.delete(id);
}

const pendingWrites = processSingleton("analysisWrites", () => new Map<string, NodeJS.Timeout>());
const PERSIST_DEBOUNCE_MS = 250;

function persist(analysis: Analysis): void {
  const existing = pendingWrites.get(analysis.id);
  if (existing) clearTimeout(existing);
  const timeout = setTimeout(() => {
    pendingWrites.delete(analysis.id);
    void (async () => {
      try {
        await mkdir(analysisDir(analysis.id), { recursive: true });
        // Write then rename, so a crash mid-write never leaves a half-written
        // analysis.json (it holds the reviews).
        const file = path.join(analysisDir(analysis.id), "analysis.json");
        await writeFile(`${file}.tmp`, JSON.stringify(analysis, null, 2));
        await rename(`${file}.tmp`, file);
      } catch (err) {
        console.error(`[analyses] failed to persist analysis ${analysis.id}:`, err);
      }
    })();
  }, PERSIST_DEBOUNCE_MS);
  timeout.unref?.();
  pendingWrites.set(analysis.id, timeout);
}
