import path from "path";
import { existsSync, createWriteStream } from "fs";
import { mkdir, rename } from "fs/promises";
import { spawn } from "child_process";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import * as ort from "onnxruntime-node";
import { getFfmpegPath } from "./binaries";
import { probeVideo } from "./media";
import { OUTPUT_ASPECT, type FramingSegment } from "../../remotion/types";

/**
 * Face-aware vertical framing. A 16:9 source shown in a 9:16 frame can either
 * be letterboxed (whole frame visible, video tiny) or cropped to fill (only
 * ~32% of the width visible). We crop to fill wherever we can keep the people
 * who matter in frame, and letterbox otherwise:
 *
 * - The clip is split into shots at scene cuts, and each shot gets one
 *   decision, so the crop never drifts mid-shot or jumps between cuts.
 * - Faces are found with UltraFace (a ~1MB CPU face detector) on 4 frames/s.
 * - One person, or several who fit inside the crop: fill, centred on them.
 * - Several people who don't fit: follow whoever is talking (most movement in
 *   the lower half of the face across frames — a still photo or a listener
 *   barely moves); if nobody clearly is, letterbox so nobody gets cut.
 * - No usable face (b-roll, graphics, wide shots): letterbox.
 *
 * Runs on CPU, so it works the same on a GPU server or a plain laptop-class box.
 */

const MODEL_URL =
  "https://raw.githubusercontent.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB/master/models/onnx/version-RFB-320.onnx";
const MODEL_PATH = path.join(process.cwd(), ".face-models", "version-RFB-320.onnx");
const IN_W = 320;
const IN_H = 240;
const FRAME_BYTES = IN_W * IN_H * 3;
const SAMPLE_FPS = 4;
// ffmpeg scdet score (0-100) that counts as a cut. Hard cuts score 30+, but
// the picture-in-picture/split-screen layout switches common in interview
// shows only score 8-13, and those need their own framing too.
const SCENE_THRESHOLD = 7;
const MIN_SHOT_SECONDS = 0.6;
const FACE_SCORE = 0.7;
const MIN_FACE_WIDTH = 0.035; // fraction of source width; smaller faces are background people
const MIN_PRESENCE = 0.3; // a person must be seen in >=30% of a shot's samples to count
// Mouth/jaw movement below this is a still object the detector mistook for a
// face (a plant leaf scored 0.02-0.04; real faces, even listeners, score 10+).
const MIN_FACE_MOTION = 1;

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      if (!existsSync(MODEL_PATH)) {
        await mkdir(path.dirname(MODEL_PATH), { recursive: true });
        const res = await fetch(MODEL_URL);
        if (!res.ok || !res.body) throw new Error(`Face model download failed (${res.status})`);
        const tmp = `${MODEL_PATH}.download`;
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
        await rename(tmp, MODEL_PATH);
      }
      // Severity 3 = errors only; the model triggers harmless initializer warnings.
      return ort.InferenceSession.create(MODEL_PATH, { logSeverityLevel: 3 });
    })().catch((err) => {
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

interface Decoded {
  frames: Buffer[];
  cuts: number[];
}

/** Decodes [start, start+duration) to 320x240 letterboxed RGB frames at SAMPLE_FPS, plus scene-cut times. */
function decode(videoPath: string, startSeconds: number, durationSeconds: number): Promise<Decoded> {
  const filter =
    `[0:v]scale=${IN_W}:-2,split=2[a][b];` +
    `[a]fps=${SAMPLE_FPS},scale=${IN_W}:${IN_H}:force_original_aspect_ratio=decrease,` +
    `pad=${IN_W}:${IN_H}:(ow-iw)/2:(oh-ih)/2,format=rgb24[raw];` +
    // scdet passes every frame through and logs cut times (select+showinfo
    // would emit nothing on a clip without cuts, which ffmpeg treats as an error).
    `[b]scdet=threshold=${SCENE_THRESHOLD}[sc]`;
  const args = [
    "-hide_banner",
    "-nostats",
    "-ss",
    startSeconds.toFixed(2),
    "-t",
    durationSeconds.toFixed(2),
    "-i",
    videoPath,
    "-filter_complex",
    filter,
    "-map",
    "[raw]",
    "-f",
    "rawvideo",
    "pipe:1",
    "-map",
    "[sc]",
    "-f",
    "null",
    "-",
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(getFfmpegPath(), args, { windowsHide: true });
    const frames: Buffer[] = [];
    let pending = Buffer.alloc(0);
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= FRAME_BYTES) {
        frames.push(Buffer.from(pending.subarray(0, FRAME_BYTES)));
        pending = pending.subarray(FRAME_BYTES);
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
      const cuts = [...stderr.matchAll(/lavfi\.scd\.time: ([\d.]+)/g)].map((m) => parseFloat(m[1]));
      resolve({ frames, cuts });
    });
  });
}

interface Face {
  // Source-normalised box (0..1 of the original frame).
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Lip/jaw movement versus the previous sample; null right after a cut. */
  motion: number | null;
}

async function detectFaces(session: ort.InferenceSession, rgb: Buffer): Promise<Array<[number, number, number, number]>> {
  const plane = IN_W * IN_H;
  const input = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    input[p] = (rgb[p * 3] - 127) / 128;
    input[plane + p] = (rgb[p * 3 + 1] - 127) / 128;
    input[2 * plane + p] = (rgb[p * 3 + 2] - 127) / 128;
  }
  const out = await session.run({ input: new ort.Tensor("float32", input, [1, 3, IN_H, IN_W]) });
  const scores = out.scores.data as Float32Array;
  const boxes = out.boxes.data as Float32Array;
  const candidates: Array<{ box: [number, number, number, number]; score: number }> = [];
  for (let i = 0; i < scores.length / 2; i++) {
    const score = scores[i * 2 + 1];
    if (score > FACE_SCORE) {
      candidates.push({ box: [boxes[i * 4], boxes[i * 4 + 1], boxes[i * 4 + 2], boxes[i * 4 + 3]], score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const kept: Array<[number, number, number, number]> = [];
  for (const c of candidates) if (kept.every((k) => iou(k, c.box) < 0.3)) kept.push(c.box);
  return kept; // normalised to the 320x240 padded input
}

function iou(a: number[], b: number[]): number {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = w * h;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}

/** Mean absolute luma change inside a pixel rect between two RGB frames. */
function regionChange(cur: Buffer, prev: Buffer, x1: number, y1: number, x2: number, y2: number): number {
  const xa = Math.max(0, Math.floor(x1));
  const xb = Math.min(IN_W, Math.ceil(x2));
  const ya = Math.max(0, Math.floor(y1));
  const yb = Math.min(IN_H, Math.ceil(y2));
  let sum = 0;
  let n = 0;
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const i = (y * IN_W + x) * 3;
      const l1 = 0.299 * cur[i] + 0.587 * cur[i + 1] + 0.114 * cur[i + 2];
      const l0 = 0.299 * prev[i] + 0.587 * prev[i + 1] + 0.114 * prev[i + 2];
      sum += Math.abs(l1 - l0);
      n++;
    }
  }
  return n ? sum / n : 0;
}

interface Person {
  cx: number[];
  cy: number[];
  left: number[];
  right: number[];
  width: number[];
  motion: number[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** Groups a shot's face detections into people by position (people in a shot mostly stay put). */
function groupPeople(samples: Face[][]): Person[] {
  const people: Person[] = [];
  for (const faces of samples) {
    for (const f of faces) {
      const cx = (f.x1 + f.x2) / 2;
      const cy = (f.y1 + f.y2) / 2;
      const width = f.x2 - f.x1;
      let person = people.find((p) => Math.abs(median(p.cx) - cx) < Math.max(0.06, median(p.width) * 0.8));
      if (!person) {
        person = { cx: [], cy: [], left: [], right: [], width: [], motion: [] };
        people.push(person);
      }
      person.cx.push(cx);
      person.cy.push(cy);
      person.left.push(f.x1);
      person.right.push(f.x2);
      person.width.push(width);
      if (f.motion !== null) person.motion.push(f.motion);
    }
  }
  return people.filter(
    (p) =>
      p.cx.length >= Math.max(2, samples.length * MIN_PRESENCE) &&
      // Motion is only measured between frames of the same shot; with no
      // measurements we can't tell, so keep the face.
      (p.motion.length === 0 || median(p.motion) >= MIN_FACE_MOTION)
  );
}

/** objectPosition x-percentage that centres a crop of width `crop` (0..1 of source width) on `center`. */
function focusPercent(center: number, crop: number): number {
  if (crop >= 1) return 50;
  const left = Math.min(Math.max(center - crop / 2, 0), 1 - crop);
  return Math.round((left / (1 - crop)) * 1000) / 10;
}

function decideShot(
  samples: Face[][],
  crop: number,
  sourceAspect: number
): Pick<FramingSegment, "mode" | "focusX" | "people" | "sourceAspect"> {
  const fit = { mode: "fit" as const, focusX: 50 };
  if (crop >= 1) return { mode: "fill", focusX: 50 }; // source is already at least as tall as 9:16
  const people = groupPeople(samples);
  if (people.length === 0) return fit;

  const margin = 0.02;
  const left = Math.min(...people.map((p) => median(p.left))) - margin;
  const right = Math.max(...people.map((p) => median(p.right))) + margin;
  if (right - left <= crop) return { mode: "fill", focusX: focusPercent((left + right) / 2, crop) };

  // A clearly dominant (much closer) face is the subject; the others are
  // background people, not a second speaker worth a half of the screen.
  const bySize = people.map((p) => ({ p, size: median(p.width) })).sort((a, b) => b.size - a.size);
  if (bySize[0].size >= 1.8 * bySize[1].size) {
    return { mode: "fill", focusX: focusPercent(median(bySize[0].p.cx), crop) };
  }

  // Two (or more) people too far apart for one crop — a podcast/interview
  // two-shot or split screen. Stack the two biggest faces, left one on top,
  // so the viewer sees both the speaker and the person they're talking to.
  const pair = bySize
    .slice(0, 2)
    .map(({ p }) => ({ cx: median(p.cx), cy: median(p.cy), w: median(p.width) }))
    .sort((a, b) => a.cx - b.cx);
  return { mode: "split", focusX: 50, people: pair, sourceAspect };
}

/**
 * Works out the vertical framing for [startSeconds, startSeconds+durationSeconds)
 * of a video, as shot segments with times relative to the clip start.
 */
export async function analyzeFraming(
  videoPath: string,
  startSeconds = 0,
  durationSeconds?: number
): Promise<FramingSegment[]> {
  const probe = await probeVideo(videoPath);
  const duration = durationSeconds ?? probe.durationSeconds - startSeconds;
  if (!probe.width || !probe.height || duration <= 0) return [];
  // Fraction of the source width a full-height 9:16 crop shows (0.316 for 16:9).
  const crop = (probe.height * OUTPUT_ASPECT) / probe.width;

  const [session, { frames, cuts }] = await Promise.all([getSession(), decode(videoPath, startSeconds, duration)]);
  if (frames.length === 0) return [];

  // Where the real picture sits inside the letterboxed 320x240 input.
  const scale = Math.min(IN_W / probe.width, IN_H / probe.height);
  const cw = probe.width * scale;
  const ch = probe.height * scale;
  const ox = (IN_W - cw) / 2;
  const oy = (IN_H - ch) / 2;

  const shotStarts = [0];
  for (const t of cuts) if (t - shotStarts[shotStarts.length - 1] >= MIN_SHOT_SECONDS && duration - t >= MIN_SHOT_SECONDS) shotStarts.push(t);
  const shotOf = (t: number) => {
    let s = 0;
    while (s + 1 < shotStarts.length && shotStarts[s + 1] <= t) s++;
    return s;
  };

  const perShot: Face[][][] = shotStarts.map(() => []);
  for (let i = 0; i < frames.length; i++) {
    const t = i / SAMPLE_FPS;
    const shot = shotOf(t);
    const sameShotAsPrev = i > 0 && shotOf((i - 1) / SAMPLE_FPS) === shot;
    const boxes = await detectFaces(session, frames[i]);
    const faces: Face[] = [];
    for (const [bx1, by1, bx2, by2] of boxes) {
      const px1 = bx1 * IN_W;
      const py1 = by1 * IN_H;
      const px2 = bx2 * IN_W;
      const py2 = by2 * IN_H;
      const face = {
        x1: (px1 - ox) / cw,
        y1: (py1 - oy) / ch,
        x2: (px2 - ox) / cw,
        y2: (py2 - oy) / ch,
        motion: null as number | null,
      };
      if (face.x2 - face.x1 < MIN_FACE_WIDTH) continue;
      if (sameShotAsPrev) {
        // Lower half of the face: mouth and jaw.
        const w = px2 - px1;
        face.motion = regionChange(frames[i], frames[i - 1], px1 + w * 0.2, py1 + (py2 - py1) * 0.55, px2 - w * 0.2, py2);
      }
      faces.push(face);
    }
    perShot[shot].push(faces);
  }

  const segments: FramingSegment[] = [];
  shotStarts.forEach((from, s) => {
    const to = s + 1 < shotStarts.length ? shotStarts[s + 1] : duration;
    const decision = decideShot(perShot[s], crop, probe.width / probe.height);
    const prev = segments[segments.length - 1];
    const samePeople =
      decision.mode !== "split" ||
      (prev?.people?.length === 2 &&
        decision.people!.every((person, k) => Math.abs(person.cx - prev.people![k].cx) < 0.05));
    if (prev && prev.mode === decision.mode && Math.abs(prev.focusX - decision.focusX) < 3 && samePeople) {
      prev.toSeconds = to; // same framing across the cut — keep it as one segment
    } else {
      segments.push({ fromSeconds: from, toSeconds: to, ...decision });
    }
  });
  return segments;
}
