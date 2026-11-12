import { randomUUID } from "crypto";
import path from "path";
import { mkdir, readFile, writeFile, readdir } from "fs/promises";
import type { ClipLengthPreset } from "./clipLength";

export type JobStatus =
  | "queued"
  | "downloading"
  | "probing"
  | "uploading"
  | "analyzing"
  | "ranking"
  | "cutting"
  | "done"
  | "error"
  | "cancelled";

export interface JobClip {
  id: string;
  startSeconds: number;
  endSeconds: number;
  title: string;
  reason: string;
  score: number;
  filename: string;
  thumbnailFilename?: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  progressMessage: string;
  createdAt: number;
  updatedAt: number;
  sourceLabel: string;
  videoDurationSeconds?: number;
  clipLength?: ClipLengthPreset;
  clips?: JobClip[];
  error?: string;
}

// In-memory cache for fast reads/writes during an active job. Every mutation
// is also persisted to disk (job.json next to the job's clips) so history
// survives a dev-server hot-reload or restart — the in-memory-only version of
// this lost track of running jobs mid-render, which is the bug that bit us.
const jobs = new Map<string, Job>();
// Kept separate from the Job record itself so it never leaks into the JSON
// status response or the persisted file — it's process-control state, not job data.
const controllers = new Map<string, AbortController>();

export const STORAGE_ROOT = path.join(process.cwd(), "storage", "jobs");

export function registerController(id: string, controller: AbortController): void {
  controllers.set(id, controller);
}

export function unregisterController(id: string): void {
  controllers.delete(id);
}

/** Signals cancellation for a running job. Returns false if the job doesn't exist or is already finished. */
export function requestCancel(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === "done" || job.status === "error" || job.status === "cancelled") return false;

  const controller = controllers.get(id);
  controller?.abort();
  updateJob(id, { status: "cancelled", progressMessage: "Cancelled by user" });
  return true;
}

export function createJob(sourceLabel: string, clipLength?: ClipLengthPreset): Job {
  const job: Job = {
    id: randomUUID(),
    status: "queued",
    progressMessage: "Queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceLabel,
    clipLength,
  };
  jobs.set(job.id, job);
  persist(job);
  return job;
}

/** Synchronous, in-memory-only lookup — use `loadJob` when the job may have started before this process instance. */
export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

/** Looks up a job, falling back to the on-disk record if it's not (or no longer) in memory. */
export async function loadJob(id: string): Promise<Job | undefined> {
  const cached = jobs.get(id);
  if (cached) return cached;

  try {
    const raw = await readFile(path.join(jobDir(id), "job.json"), "utf8");
    const job = JSON.parse(raw) as Job;
    jobs.set(id, job);
    return job;
  } catch {
    return undefined;
  }
}

export function updateJob(id: string, patch: Partial<Job>): void {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: Date.now() });
  persist(job);
}

const pendingWrites = new Map<string, NodeJS.Timeout>();
const PERSIST_DEBOUNCE_MS = 250;

function persist(job: Job): void {
  // Render progress callbacks can fire many times a second; writing a fresh
  // job.json on every single one would hammer disk I/O and risks overlapping
  // writes corrupting a read. Debounce to one write per ~250ms per job, always
  // capturing the latest snapshot (the closure below reads `job` fresh at
  // write time via the outer reference passed in, not the one at schedule time).
  const existing = pendingWrites.get(job.id);
  if (existing) clearTimeout(existing);

  const timeout = setTimeout(() => {
    pendingWrites.delete(job.id);
    void (async () => {
      try {
        await mkdir(jobDir(job.id), { recursive: true });
        await writeFile(path.join(jobDir(job.id), "job.json"), JSON.stringify(job, null, 2));
      } catch (err) {
        console.error(`[jobs] failed to persist job ${job.id}:`, err);
      }
    })();
  }, PERSIST_DEBOUNCE_MS);
  // Don't keep the process alive just for a pending debounce write.
  timeout.unref?.();
  pendingWrites.set(job.id, timeout);
}

/** Lists all known jobs (in-memory + on-disk), newest first. Used for the library/history view. */
export async function listJobs(): Promise<Job[]> {
  let entries: string[];
  try {
    entries = await readdir(STORAGE_ROOT);
  } catch {
    return [];
  }

  const results: Job[] = [];
  for (const id of entries) {
    const job = await loadJob(id);
    if (job) results.push(job);
  }
  results.sort((a, b) => b.createdAt - a.createdAt);
  return results;
}

/** Removes a job's in-memory/controller state. Caller is responsible for deleting its storage directory. */
export function forgetJob(id: string): void {
  jobs.delete(id);
  controllers.delete(id);
}

export function jobDir(id: string): string {
  return path.join(STORAGE_ROOT, id);
}

export async function ensureJobDir(id: string): Promise<string> {
  const dir = jobDir(id);
  await mkdir(dir, { recursive: true });
  return dir;
}
