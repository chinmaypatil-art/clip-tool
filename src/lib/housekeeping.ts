import path from "path";
import { readdir, rm, statfs } from "fs/promises";
import { ANALYSES_ROOT, analysisDir, listAnalyses, updateAnalysis, type Analysis } from "./analyses";

/**
 * Keeps the disk from filling up while the app runs unattended:
 * - deletes leftover audio files (only needed while a clip renders);
 * - deletes a video's downloaded source after SOURCE_KEEP_DAYS, or sooner,
 *   oldest first, when free space drops under LOW_DISK_GB. Rendered clips
 *   and analysis.json (transcript, picks, reviews) are always kept;
 *   without the source a clip just can't be re-rendered.
 * New videos are refused below MIN_FREE_GB (see hasRoomForNewVideo).
 */
const GB = 1024 ** 3;
const SOURCE_KEEP_DAYS = Number(process.env.SOURCE_KEEP_DAYS ?? 3);
const LOW_DISK_GB = Number(process.env.LOW_DISK_GB ?? 30);
const MIN_FREE_GB = Number(process.env.MIN_FREE_GB ?? 10);

export async function freeBytes(): Promise<number> {
  const s = await statfs(ANALYSES_ROOT).catch(() => statfs(process.cwd()));
  return s.bavail * s.bsize;
}

export async function hasRoomForNewVideo(): Promise<boolean> {
  return (await freeBytes()) >= MIN_FREE_GB * GB;
}

function isBusy(a: Analysis): boolean {
  return (
    a.status === "extracting_transcript" ||
    a.runs.some((r) => r.status === "running" || r.status === "queued" || r.clips.some((c) => c.renderStatus === "rendering"))
  );
}

async function deleteFiles(id: string, keep: (file: string) => boolean): Promise<number> {
  const dir = analysisDir(id);
  const doomed = (await readdir(dir).catch(() => [] as string[])).filter((f) => !keep(f));
  for (const f of doomed) await rm(path.join(dir, f), { force: true }).catch(() => {});
  return doomed.length;
}

export async function sweepStorage(): Promise<void> {
  const idle = (await listAnalyses()).filter((a) => !isBusy(a));
  let removed = 0;
  for (const a of idle) removed += await deleteFiles(a.id, (f) => !f.endsWith(".wav"));

  const withSource = idle.filter((a) => !a.sourceDeleted).sort((x, y) => x.updatedAt - y.updatedAt);
  const dropSource = async (a: Analysis) => {
    removed += await deleteFiles(a.id, (f) => f !== "source.mp4" && !f.startsWith("upload-raw"));
    updateAnalysis(a.id, { sourceDeleted: true });
  };
  const cutoff = Date.now() - SOURCE_KEEP_DAYS * 24 * 3600 * 1000;
  for (const a of withSource.filter((a) => a.updatedAt < cutoff)) await dropSource(a);
  for (const a of withSource.filter((a) => a.updatedAt >= cutoff)) {
    if ((await freeBytes()) >= LOW_DISK_GB * GB) break;
    await dropSource(a);
  }
  if (removed) console.log(`[housekeeping] removed ${removed} files; ${((await freeBytes()) / GB).toFixed(0)} GB free`);
}
