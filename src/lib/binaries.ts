import { existsSync, readdirSync } from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const resolved = new Map<string, string>();

/**
 * Resolves a CLI tool's absolute path: PATH first, then the current user's
 * winget folders (a process started before a winget install, or detached from
 * its shell, may not see them on PATH). The result is cached, so a tool found
 * once keeps working for the life of the server.
 */
function resolveBinary(name: string, candidates: string[]): string {
  const cached = resolved.get(name);
  if (cached && existsSync(cached)) return cached;
  const found = findBinary(name, candidates);
  resolved.set(name, found);
  return found;
}

function findBinary(name: string, candidates: string[]): string {
  try {
    const where = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(where, [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
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

const WINGET = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Microsoft", "WinGet");
const WINGET_PACKAGES = path.join(WINGET, "Packages");

/** winget's shims folder, then the exe inside each package folder with the given prefix. */
function wingetCandidates(exe: string, packagePrefix: string): string[] {
  const out = [path.join(WINGET, "Links", exe)];
  try {
    for (const pkg of readdirSync(WINGET_PACKAGES).filter((d) => d.startsWith(packagePrefix))) {
      const dir = path.join(WINGET_PACKAGES, pkg);
      out.push(path.join(dir, exe));
      // ffmpeg builds nest the exe under <version>/bin/.
      for (const sub of readdirSync(dir)) out.push(path.join(dir, sub, "bin", exe));
    }
  } catch {
    // no winget on this machine
  }
  return out;
}

export function getFfmpegPath(): string {
  return resolveBinary("ffmpeg", wingetCandidates("ffmpeg.exe", "Gyan.FFmpeg"));
}

export function getFfprobePath(): string {
  return resolveBinary("ffprobe", wingetCandidates("ffprobe.exe", "Gyan.FFmpeg"));
}

export function getYtDlpPath(): string {
  return resolveBinary("yt-dlp", wingetCandidates("yt-dlp.exe", "yt-dlp.yt-dlp"));
}
