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

async function frames(sourcePath: string, start: number, length: number, step = Math.max(MIN_STEP_SECONDS, length / MAX_FRAMES)): Promise<{ times: number[]; images: string[] }> {
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

// "End it properly": frames over most of the clip and a little past its end.
// Most of the clip: the moment may be over long before the current end.
const END_LOOK_SHARE = 0.75;
const END_LOOK_AFTER = 10;
const END_FRAMES = 16;

type Beat = "play" | "result" | "reaction" | "idle" | "break";

const BEAT_PROMPT = `This is one frame from a video clip. Which ONE describes it best?

"play": the action itself, while it is happening: a ball being bowled, hit, thrown, kicked or caught; players running for the ball; a rally, raid, trick or stunt; someone in the middle of doing the clip's main thing.
"result": a graphic or screen showing what happened (OUT, WICKET, SIX, FOUR, GOAL, a score change), or a replay of the action.
"reaction": people reacting to what just happened: celebrating, hugging, high-fives, shouting, a crowd cheering, someone laughing or shocked.
"idle": nothing is happening: people walking, standing or waiting, a batter walking in or out or adjusting gloves or bat, a new player walking in, players getting ready for the next ball or play, a close-up of one person doing nothing, an empty field.
"break": an ad, a channel logo or intro, a sponsor or "subscribe" screen, a studio, a blank or frozen screen.

Return JSON {"beat": "play" | "result" | "reaction" | "idle" | "break"}.`;

async function beatOf(model: string, image: string): Promise<Beat | null> {
  try {
    const res = await fetch(OLLAMA_CHAT, {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: BEAT_PROMPT, images: [image] }],
        format: "json",
        stream: false,
        options: { temperature: 0, num_ctx: 4096 },
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { message?: { content?: string } };
    const beat = JSON.parse(body.message?.content ?? "{}").beat;
    return ["play", "result", "reaction", "idle", "break"].includes(beat) ? beat : null;
  } catch {
    return null;
  }
}

/**
 * Where a clip's moment visibly finishes, for "end it properly" in Ask AI:
 * local Gemma labels frames around the end (play, result, reaction, idle,
 * break); the clip ends after the last result or reaction that follows the
 * action, before two idle/break frames in a row. Returns the new end in
 * source seconds and what it saw, or null if it can't tell.
 */
export async function findMomentEnd(sourcePath: string, start: number, end: number, model: string): Promise<{ end: number; why: string } | null> {
  const from = Math.max(start + 3, end - Math.max(15, (end - start) * END_LOOK_SHARE));
  const length = end + END_LOOK_AFTER - from;
  const { times, images } = await frames(sourcePath, from, length, length / END_FRAMES);
  if (images.length < 3) return null;
  const beats: Array<Beat | null> = [];
  for (const image of images) beats.push(await beatOf(model, image));
  if (process.env.SCREEN_DEBUG) console.log("[findMomentEnd]", times.map((t, i) => `${(from + t - start).toFixed(0)}s:${beats[i]}`).join(" "));

  const moving = (b: Beat | null) => b === "play" || b === "result" || b === "reaction";
  let last = -1;
  let seenPlay = false;
  for (let i = 0; i < beats.length; i++) {
    if (beats[i] === "play") seenPlay = true;
    if (moving(beats[i])) last = i;
    // Two dull frames in a row after the action: the moment is over.
    else if (seenPlay && last >= 0 && i + 1 < beats.length && !moving(beats[i + 1])) break;
  }
  if (last < 0) return null;
  const step = times.length > 1 ? times[1] - times[0] : 1;
  const beat = beats[last];
  return {
    end: from + times[last] + step / 2,
    why: beat === "result" ? "after the result is shown" : beat === "reaction" ? "after the reaction" : "after the action",
  };
}
