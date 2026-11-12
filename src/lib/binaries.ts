import { existsSync } from "fs";
import { execFileSync } from "child_process";

/**
 * Resolves a CLI tool's absolute path. On this dev machine, ffmpeg/yt-dlp were
 * installed via winget mid-session, so the current process PATH may not
 * include them yet (requires a fresh shell). We fall back to the known
 * winget install locations instead of assuming a PATH restart happened.
 */
function resolveBinary(name: string, candidates: string[]): string {
  try {
    const where = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(where, [name], { encoding: "utf8" }).trim();
    const first = out.split(/\r?\n/)[0];
    if (first) return first;
  } catch {
    // not on PATH, fall through to candidates
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not locate "${name}". Looked on PATH and at: ${candidates.join(", ")}`
  );
}

const WINGET_PACKAGES = "C:\\Users\\Admin\\AppData\\Local\\Microsoft\\WinGet\\Packages";

export function getFfmpegPath(): string {
  return resolveBinary("ffmpeg", [
    `${WINGET_PACKAGES}\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffmpeg.exe`,
  ]);
}

export function getFfprobePath(): string {
  return resolveBinary("ffprobe", [
    `${WINGET_PACKAGES}\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffprobe.exe`,
  ]);
}

export function getYtDlpPath(): string {
  return resolveBinary("yt-dlp", [
    `${WINGET_PACKAGES}\\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\\yt-dlp.exe`,
  ]);
}
