import { statfs } from "fs/promises";
import { ANALYSES_ROOT } from "./analyses";

/**
 * Disk-space guard: new videos are refused when free space drops under
 * MIN_FREE_GB, so a full disk can't break jobs halfway. Nothing is ever
 * deleted automatically.
 */
const GB = 1024 ** 3;
const MIN_FREE_GB = Number(process.env.MIN_FREE_GB ?? 10);

export async function freeBytes(): Promise<number> {
  const s = await statfs(ANALYSES_ROOT).catch(() => statfs(process.cwd()));
  return s.bavail * s.bsize;
}

export async function hasRoomForNewVideo(): Promise<boolean> {
  return (await freeBytes()) >= MIN_FREE_GB * GB;
}
