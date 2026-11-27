import path from "path";
import { mkdtemp, readdir, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { getFfmpegPath } from "./binaries";

const run = promisify(execFile);

/**
 * Pickers that read the transcript can't see the picture: a cricket stream's
 * commentator keeps talking over the sponsor's ad and the channel's logo
 * animation, and two of five picks were nothing but ads. Local Gemma (it can
 * read images) looks at frames across each pick; ad or logo stretches at the
 * edges are trimmed off, and a pick that is mostly ads is dropped.
 */

const OLLAMA_CHAT = "http://127.0.0.1:11434/api/chat";
const MAX_FRAMES = 12; // per clip: ~1-2 s each on the GPU
const MIN_STEP_SECONDS = 3;
const MAX_BAD_SHARE = 0.34; // more than a third ads/logos left after trimming: drop it

type Kind = "content" | "ad";

interface Pick {
  startSeconds: number;
  endSeconds: number;
  title?: string;
}

const PROMPT = `This is one frame from a video. Is it the actual video content, or a break in it?

"content": the event or show itself: players, a match, a game being played, a field or pitch, a crowd, people talking or cooking or doing things on camera, a replay of the action. A score bar or a small logo in a corner on top of real footage is still "content".
"ad": an advertisement or sponsor message, a channel intro/logo animation filling the screen, a poster, flyer or price list, a "subscribe/follow us" screen, a full-screen title card or graphic with no live footage behind it.

Return JSON {"kind": "content"} or {"kind": "ad"}.`;

async function frames(sourcePath: string, start: number, length: number): Promise<{ times: number[]; images: string[] }> {
  const step = Math.max(MIN_STEP_SECONDS, length / MAX_FRAMES);
  const dir = await mkdtemp(path.join(tmpdir(), "clipwise-screen-"));
  try {
    const times: number[] = [];
    for (let t = step / 2; t < length; t += step) times.push(t);
    // One seek per frame: fast on a long source, unlike decoding the whole stretch.
    await Promise.all(
      times.map((t, i) =>
        run(getFfmpegPath(), ["-v", "error", "-ss", (start + t).toFixed(2), "-i", sourcePath, "-frames:v", "1", "-vf", "scale=448:-2", "-q:v", "4", "-y", path.join(dir, `f${String(i).padStart(3, "0")}.jpg`)], {
          timeout: 60_000,
          windowsHide: true,
        }).catch(() => null)
      )
    );
    const files = (await readdir(dir)).sort();
    const images = await Promise.all(files.map(async (f) => (await readFile(path.join(dir, f))).toString("base64")));
    return { times: files.map((f) => times[Number(f.slice(1, 4))]), images };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function classify(model: string, image: string): Promise<Kind | null> {
  try {
    const res = await fetch(OLLAMA_CHAT, {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: PROMPT, images: [image] }],
        format: "json",
        stream: false,
        options: { temperature: 0, num_ctx: 4096 },
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { message?: { content?: string } };
    const kind = JSON.parse(body.message?.content ?? "{}").kind;
    return kind === "ad" ? "ad" : kind === "content" ? "content" : null;
  } catch {
    return null; // can't tell: treated as content, never drops a clip on its own
  }
}

/**
 * Trims ad/logo stretches off each pick's edges and drops picks that are
 * mostly ads. Picks it can't check come back unchanged.
 */
export async function screenClips<T extends Pick>(sourcePath: string, picks: T[], model: string, minSeconds: number): Promise<T[]> {
  const kept: T[] = [];
  for (const pick of picks) {
    const length = pick.endSeconds - pick.startSeconds;
    const { times, images } = await frames(sourcePath, pick.startSeconds, length);
    if (!images.length) {
      kept.push(pick);
      continue;
    }
    const kinds: Kind[] = [];
    for (const image of images) kinds.push((await classify(model, image)) ?? "content");
    if (process.env.SCREEN_DEBUG) console.log("[screenClips]", pick.title, times.map((t, i) => `${t.toFixed(0)}s:${kinds[i]}`).join(" "));

    // A break of two or more ad frames splits the pick; keep the longest stretch of
    // content. One stray ad frame inside real footage doesn't split it.
    let first = -1;
    let last = -1;
    for (let i = 0; i < kinds.length; ) {
      if (kinds[i] !== "content") {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < kinds.length && (kinds[j + 1] === "content" || (kinds[j + 2] === "content" && j + 2 < kinds.length))) j++;
      if (first === -1 || j - i > last - first) [first, last] = [i, j];
      i = j + 1;
    }
    const label = `${pick.title ?? ""} @${Math.round(pick.startSeconds)}s`;
    if (first === -1) {
      console.log(`[screenClips] dropped "${label}": all ${kinds.length} frames are ads/logos`);
      continue;
    }
    // Cut halfway between a bad frame and the first/last good one.
    const step = times.length > 1 ? times[1] - times[0] : length;
    const start = first === 0 ? pick.startSeconds : pick.startSeconds + times[first] - step / 2;
    const end = last === kinds.length - 1 ? pick.endSeconds : pick.startSeconds + times[last] + step / 2;
    const inside = kinds.slice(first, last + 1);
    const badShare = inside.filter((k) => k === "ad").length / inside.length;
    if (end - start < Math.max(5, minSeconds * 0.5) || badShare > MAX_BAD_SHARE) {
      console.log(`[screenClips] dropped "${label}": ${kinds.filter((k) => k === "ad").length}/${kinds.length} frames are ads/logos`);
      continue;
    }
    if (start !== pick.startSeconds || end !== pick.endSeconds) {
      console.log(`[screenClips] trimmed ads off "${label}": ${pick.startSeconds.toFixed(1)}-${pick.endSeconds.toFixed(1)} -> ${start.toFixed(1)}-${end.toFixed(1)}`);
    }
    kept.push({ ...pick, startSeconds: start, endSeconds: end });
  }
  return kept;
}
