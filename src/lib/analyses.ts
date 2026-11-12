import { randomUUID } from "crypto";
import path from "path";
import { mkdir, readFile, writeFile, readdir } from "fs/promises";
import type { TranscriptSegment } from "./transcript";
import type { NormalizedClip } from "./providers/types";
import type { Provider } from "./keystore";

export type AnalysisStatus = "extracting_transcript" | "ready" | "error";
export type RunStatus = "queued" | "running" | "done" | "error";
export type RenderStatus = "pending" | "rendering" | "done" | "error";

export interface AnalysisClip extends NormalizedClip {
  id: string;
  renderStatus: RenderStatus;
  renderFilename?: string;
  renderThumbnailFilename?: string;
  renderError?: string;
}

export interface ModelRun {
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
  clips: AnalysisClip[];
  rawResponse: unknown;
}

export interface Analysis {
  id: string;
  sourceLabel: string;
  sourceKind: "youtube" | "file";
  sourceUrl?: string;
  status: AnalysisStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  videoDurationSeconds: number | null;
  transcript: { segments: TranscriptSegment[]; language: string; source: string } | null;
  runs: ModelRun[];
}

const analyses = new Map<string, Analysis>();
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
    analyses.set(id, analysis);
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

const pendingWrites = new Map<string, NodeJS.Timeout>();
const PERSIST_DEBOUNCE_MS = 250;

function persist(analysis: Analysis): void {
  const existing = pendingWrites.get(analysis.id);
  if (existing) clearTimeout(existing);
  const timeout = setTimeout(() => {
    pendingWrites.delete(analysis.id);
    void (async () => {
      try {
        await mkdir(analysisDir(analysis.id), { recursive: true });
        await writeFile(path.join(analysisDir(analysis.id), "analysis.json"), JSON.stringify(analysis, null, 2));
      } catch (err) {
        console.error(`[analyses] failed to persist analysis ${analysis.id}:`, err);
      }
    })();
  }, PERSIST_DEBOUNCE_MS);
  timeout.unref?.();
  pendingWrites.set(analysis.id, timeout);
}
