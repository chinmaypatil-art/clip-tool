import os from "os";
import path from "path";
import { existsSync, createWriteStream } from "fs";
import { mkdir, readFile, rename, rm } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import {
  installWhisperCpp,
  downloadWhisperModel,
  transcribe as whisperTranscribe,
  toCaptions,
  type WhisperModel,
  type Language,
} from "@remotion/install-whisper-cpp";
import type { Caption } from "@remotion/captions";
import { devanagariToHinglish, hasDevanagari } from "./transliterate";
import { romanizeHinglishWords } from "./gemini";
import { extractAudioSegment } from "./media";

const execFileAsync = promisify(execFile);

export class WhisperError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "WhisperError";
  }
}

// Whisper runs on whatever machine hosts this app, not on the visitor's
// device — so it has to work on a plain CPU server as well as a GPU box.
// We detect an NVIDIA GPU at runtime and use the CUDA build of whisper.cpp
// when there is one, otherwise the CPU build. If the CUDA build fails at run
// time (driver problem etc.) we fall back to CPU for the rest of the process.
//
// 1.8.x is needed for large-v3-turbo (1.5.5 predates it). For versions
// >= 1.7.4 Remotion looks for <runtime>/build/bin/whisper-cli(.exe).
const WHISPER_CPP_VERSION = "1.8.7";
const GPU_RUNTIME_DIR = path.join(process.cwd(), ".whisper-runtime-gpu");
const CPU_RUNTIME_DIR = path.join(process.cwd(), ".whisper-runtime-cpu");
// Models are shared by both runtimes so the 1.6GB turbo model exists once.
const MODELS_DIR = path.join(process.cwd(), ".whisper-models");
const RELEASE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/v${WHISPER_CPP_VERSION}`;
const WINDOWS_ZIPS = {
  gpu: `${RELEASE_URL}/whisper-cublas-12.4.0-bin-x64.zip`, // bundles the CUDA runtime DLLs; needs an NVIDIA driver
  cpu: `${RELEASE_URL}/whisper-bin-x64.zip`,
} as const;

const SUPPORTED_MODELS: readonly WhisperModel[] = [
  "tiny",
  "base",
  "small",
  "medium",
  "large-v3",
  "large-v3-turbo",
];
// large-v3-turbo: multilingual and close to large-v3 accuracy at a fraction of
// its cost. WHISPER_MODEL=small is the escape hatch for very weak CPU servers.
const WHISPER_MODEL: WhisperModel = SUPPORTED_MODELS.includes(process.env.WHISPER_MODEL as WhisperModel)
  ? (process.env.WHISPER_MODEL as WhisperModel)
  : "large-v3-turbo";

// English, Hindi and Hinglish audio is transcribed with Whisper's Hindi
// setting plus a short romanised-Hinglish prompt, then romanised. Auto mode
// labels code-mixed Hinglish as English and *translates* the Hindi parts (or
// flips to Devanagari mid-clip), and often labels Hindi as Urdu (Arabic
// script). The Hindi setting writes down what was actually said; the prompt
// keeps most English words in Latin script and makes skipped speech rarer.
// Pure English audio comes out the same as an English transcription. Other
// languages are transcribed as themselves. WHISPER_LANGUAGE=<code> skips
// detection, the prompt and romanisation.
const HINDI_FAMILY = new Set(["en", "hi", "ur"]);
const HINGLISH_PROMPT = "Haan yaar, sach mein? Matlab yeh toh kamaal hai, lekin mujhe nahi pata tha.";
const LANGUAGE_OVERRIDE = process.env.WHISPER_LANGUAGE?.trim().toLowerCase() || null;

// Whisper sometimes ends a 30s window early and jumps to the next one,
// dropping speech, and stretches the last word before the jump over the hole.
// Holes between words that still contain speech are transcribed again on
// their own and filled in.
const MAX_WORD_MS = 1500; // longest plausible single spoken word
const GAP_MS = 2000;
const FRAME_MS = 30;

// whisper.cpp stops scaling much past ~8 threads.
const THREADS = Math.max(1, Math.min(8, os.availableParallelism()));

type Device = "gpu" | "cpu";

let devicePromise: Promise<Device> | null = null;
let gpuFailed = false;
const runtimeSetup = new Map<Device, Promise<void>>();
let modelSetup: Promise<void> | null = null;

/** WHISPER_DEVICE=cpu|gpu forces a device; default is auto-detect. */
function detectDevice(): Promise<Device> {
  if (!devicePromise) {
    devicePromise = (async () => {
      const forced = process.env.WHISPER_DEVICE?.toLowerCase();
      if (forced === "cpu" || forced === "gpu") return forced;
      // Only the Windows prebuilt CUDA zip is wired up. On macOS the source
      // build uses Metal automatically; Linux gets the CPU build.
      if (process.platform !== "win32") return "cpu";
      try {
        const { stdout } = await execFileAsync("nvidia-smi", ["-L"], { timeout: 5000, windowsHide: true });
        return /GPU \d+:/.test(stdout) ? "gpu" : "cpu";
      } catch {
        return "cpu";
      }
    })();
  }
  return devicePromise;
}

function runtimeDir(device: Device): string {
  return device === "gpu" ? GPU_RUNTIME_DIR : CPU_RUNTIME_DIR;
}

/** Downloads a whisper.cpp Windows release zip and unpacks its Release/ folder into <dir>/build/bin. */
async function installWindowsRelease(url: string, dir: string): Promise<void> {
  const binDir = path.join(dir, "build", "bin");
  if (existsSync(path.join(binDir, "whisper-cli.exe"))) return;
  const work = path.join(dir, "_install");
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  try {
    const zipPath = path.join(work, "whisper.zip");
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zipPath));
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${work}'`,
    ]);
    await rm(binDir, { recursive: true, force: true });
    await mkdir(path.dirname(binDir), { recursive: true });
    await rename(path.join(work, "Release"), binDir);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function ensureRuntime(device: Device): Promise<void> {
  let setup = runtimeSetup.get(device);
  if (!setup) {
    setup = (async () => {
      const dir = runtimeDir(device);
      if (process.platform === "win32") {
        await installWindowsRelease(WINDOWS_ZIPS[device], dir);
      } else if (!existsSync(path.join(dir, "build", "bin", "whisper-cli"))) {
        // Clones and builds whisper.cpp from source (needs git, make, cmake, a compiler).
        await installWhisperCpp({ to: dir, version: WHISPER_CPP_VERSION, printOutput: false });
      }
    })().catch((err) => {
      runtimeSetup.delete(device); // allow retry on next call
      throw err;
    });
    runtimeSetup.set(device, setup);
  }
  return setup;
}

function ensureModel(): Promise<void> {
  if (!modelSetup) {
    modelSetup = (async () => {
      await mkdir(MODELS_DIR, { recursive: true });
      try {
        await downloadWhisperModel({ model: WHISPER_MODEL, folder: MODELS_DIR, printOutput: false });
      } catch {
        // Throws when a previous download was interrupted (size mismatch):
        // remove the partial file and download it again once.
        await rm(path.join(MODELS_DIR, `ggml-${WHISPER_MODEL}.bin`), { force: true });
        await downloadWhisperModel({ model: WHISPER_MODEL, folder: MODELS_DIR, printOutput: false });
      }
    })().catch((err) => {
      modelSetup = null;
      throw err;
    });
  }
  return modelSetup;
}

function activeDevice(detected: Device): Device {
  return detected === "gpu" && !gpuFailed ? "gpu" : "cpu";
}

/** Runs `task` on the detected device; if the GPU build fails, retries on CPU and stays there. */
async function onBestDevice<T>(task: (device: Device) => Promise<T>): Promise<T> {
  const device = activeDevice(await detectDevice());
  try {
    return await task(device);
  } catch (err) {
    if (device !== "gpu") throw err;
    console.error("[whisper] GPU transcription failed, falling back to CPU for this process:", describeError(err));
    gpuFailed = true;
    return task("cpu");
  }
}

async function runWhisper(device: Device, wavPath: string, language: Language, prompt: string | null): Promise<Caption[]> {
  await Promise.all([ensureRuntime(device), ensureModel()]);
  const output = await whisperTranscribe({
    model: WHISPER_MODEL,
    modelFolder: MODELS_DIR,
    whisperPath: runtimeDir(device),
    whisperCppVersion: WHISPER_CPP_VERSION,
    inputPath: wavPath,
    tokenLevelTimestamps: true,
    language,
    // -sow: with --max-len 1 (set by tokenLevelTimestamps) every item becomes a
    // whole word instead of a BPE sub-word piece. Passed raw because Remotion's
    // splitOnWord option appends a value that whisper-cli reads as an input file.
    // -nfa: whisper.cpp 1.8 turns flash attention on by default, which silently
    // disables the --dtw word alignment that tokenLevelTimestamps asks for.
    additionalArgs: ["-sow", "-nfa", "-t", String(THREADS), ...(prompt ? ["--prompt", prompt] : [])],
    printOutput: process.env.WHISPER_VERBOSE === "1",
  });
  return alignedStarts(mergeSubwordTokens(toCaptions({ whisperCppOutput: output }).captions));
}

// DTW onsets measured 0.1-0.3s after the audio onset; a caption that shows a
// beat early reads better than one that lags.
const DTW_LEAD_MS = 150;

/**
 * Starts each word at its DTW-aligned time. Whisper's own token offsets were
 * up to 1.25s off the audio (captions visibly out of sync); DTW was within
 * 0.3s on the same clip.
 */
function alignedStarts(captions: Caption[]): Caption[] {
  let prevStart = 0;
  return captions.map((c) => {
    if (c.timestampMs === null) {
      prevStart = Math.max(prevStart, c.startMs);
      return c;
    }
    const startMs = Math.max(prevStart, c.timestampMs - DTW_LEAD_MS, 0);
    prevStart = startMs;
    return { ...c, startMs, endMs: Math.max(c.endMs, startMs + 250) };
  });
}

function transcribeWords(wavPath: string, language: Language, prompt: string | null): Promise<Caption[]> {
  return onBestDevice((device) => runWhisper(device, wavPath, language, prompt));
}

/** Language detection only (whisper-cli -dl): one encoder pass over the first 30s, no decoding. */
async function detectLanguage(wavPath: string): Promise<string> {
  const device = activeDevice(await detectDevice());
  await Promise.all([ensureRuntime(device), ensureModel()]);
  const exe = path.join(runtimeDir(device), "build", "bin", process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
  const { stdout, stderr } = await execFileAsync(
    exe,
    ["-m", path.join(MODELS_DIR, `ggml-${WHISPER_MODEL}.bin`), "-f", wavPath, "-l", "auto", "-dl", "-t", String(THREADS)],
    { cwd: runtimeDir(device), windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
  );
  const match = /auto-detected language: (\w+)/.exec(stderr + stdout);
  if (!match) throw new Error("whisper-cli did not report a detected language");
  return match[1];
}

/** RMS loudness of each 30ms frame of a 16-bit PCM WAV (as written by extractAudioSegment). */
async function frameLoudness(wavPath: string): Promise<{ rms: Float32Array; durationMs: number }> {
  const buf = await readFile(wavPath);
  let offset = 12; // past "RIFF" <size> "WAVE"
  let sampleRate = 16000;
  let channels = 1;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
    } else if (id === "data") {
      const start = offset + 8;
      const sampleCount = Math.floor((Math.min(buf.length, start + size) - start) / 2 / channels);
      const frameLen = Math.round((sampleRate * FRAME_MS) / 1000);
      const rms = new Float32Array(Math.ceil(sampleCount / frameLen));
      for (let f = 0; f < rms.length; f++) {
        let sum = 0;
        const end = Math.min(sampleCount, (f + 1) * frameLen);
        for (let i = f * frameLen; i < end; i++) {
          const v = buf.readInt16LE(start + i * 2 * channels);
          sum += v * v;
        }
        rms[f] = Math.sqrt(sum / Math.max(1, end - f * frameLen));
      }
      return { rms, durationMs: (sampleCount / sampleRate) * 1000 };
    }
    offset += 8 + size + (size & 1);
  }
  throw new Error(`No PCM data found in ${wavPath}`);
}

/** True if at least a quarter of the range is as loud as speech in this clip, so we don't feed Whisper silence to hallucinate on. */
function containsSpeech(rms: Float32Array, startMs: number, endMs: number): boolean {
  const sorted = Float32Array.from(rms).sort();
  const threshold = Math.max(300, 0.2 * sorted[Math.floor(sorted.length * 0.9)]);
  const from = Math.floor(startMs / FRAME_MS);
  const to = Math.min(rms.length, Math.ceil(endMs / FRAME_MS));
  let loud = 0;
  for (let f = from; f < to; f++) if (rms[f] >= threshold) loud++;
  return to > from && loud / (to - from) >= 0.25;
}

interface Gap {
  startMs: number;
  endMs: number;
  /** Start of the word right before the hole — Whisper usually cut it off mid-word. */
  cutWordStartMs: number | null;
}

function findGaps(captions: Caption[], durationMs: number): Gap[] {
  const gaps: Gap[] = [];
  let cursor = 0;
  let lastStart: number | null = null;
  for (const c of captions) {
    if (c.startMs - cursor > GAP_MS) gaps.push({ startMs: cursor, endMs: c.startMs, cutWordStartMs: lastStart });
    cursor = Math.max(cursor, Math.min(c.endMs, c.startMs + MAX_WORD_MS));
    lastStart = c.startMs;
  }
  if (durationMs - cursor > GAP_MS) gaps.push({ startMs: cursor, endMs: durationMs, cutWordStartMs: lastStart });
  return gaps;
}

const FILL_ROUNDS = 3; // a re-transcription can itself stop early, leaving a smaller hole

/** Re-transcribes holes Whisper skipped (see GAP_MS) and splices the words in. */
async function fillGaps(wavPath: string, captions: Caption[], language: Language, prompt: string | null): Promise<Caption[]> {
  const { rms, durationMs } = await frameLoudness(wavPath);
  let words = captions;
  const attempted = new Set<string>();
  for (let round = 0; round < FILL_ROUNDS; round++) {
    const gaps = findGaps(words, durationMs).filter(
      (g) => containsSpeech(rms, g.startMs, g.endMs) && !attempted.has(`${g.startMs}-${g.endMs}`)
    );
    if (gaps.length === 0) break;
    for (const [i, gap] of gaps.entries()) {
      attempted.add(`${gap.startMs}-${gap.endMs}`);
      // Start at the cut-off word so it gets transcribed whole, then replace it.
      const redoFromMs = gap.cutWordStartMs ?? gap.startMs;
      const fromMs = Math.max(0, redoFromMs - 200);
      const toMs = Math.min(durationMs, gap.endMs + 200);
      const gapWav = `${wavPath}.gap${round}-${i}.wav`;
      try {
        await extractAudioSegment(wavPath, gapWav, fromMs / 1000, (toMs - fromMs) / 1000);
        const found = (await transcribeWords(gapWav, language, prompt))
          .map((c) => ({
            ...c,
            startMs: c.startMs + fromMs,
            endMs: c.endMs + fromMs,
            timestampMs: c.timestampMs === null ? null : c.timestampMs + fromMs,
          }))
          .filter((c) => c.startMs >= redoFromMs - 300 && c.startMs < gap.endMs);
        if (found.length === 0) continue;
        words = [...words.filter((w) => w.startMs < redoFromMs - 300 || w.startMs >= gap.endMs), ...found].sort(
          (a, b) => a.startMs - b.startMs
        );
      } catch (err) {
        console.error(`[whisper] re-transcribing skipped audio ${gap.startMs}-${gap.endMs}ms failed:`, describeError(err));
      } finally {
        await rm(gapWav, { force: true });
      }
    }
  }
  words = [...words].sort((a, b) => a.startMs - b.startMs);
  // A word ends by the next word's start and at most 3s after it begins, so a
  // word that was stretched over a hole isn't highlighted through all of it.
  return words.map((c, i) => {
    const next = words[i + 1];
    let endMs = Math.min(c.endMs, c.startMs + 3000);
    if (next) endMs = Math.min(endMs, Math.max(c.startMs, next.startMs));
    return { ...c, text: i === 0 ? c.text.trimStart() : " " + c.text.trimStart(), endMs };
  });
}

// Latin letters with accents ("bäťe") — Whisper's Hindi mode sometimes writes
// romanised Hindi this way.
const ACCENTED_LATIN = /[À-ɏḀ-ỿ]/;

/** Removes accents from Latin letters ("bäťe" -> "bate"). */
function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/(\p{Script=Latin})\p{M}+/gu, "$1").normalize("NFC");
}

/** Turns caption words into romanised Hinglish; null entries fall back to rule-based transliteration. */
export type Romanizer = (words: string[], reference?: string) => Promise<Array<string | null>>;

/** Rewrites Devanagari (and accented Latin) words as Hinglish in Latin script, keeping one caption — and its timing — per word. */
async function romanize(captions: Caption[], romanizer: Romanizer, reference?: string): Promise<Caption[]> {
  if (!captions.some((c) => hasDevanagari(c.text) || ACCENTED_LATIN.test(c.text))) return captions;
  let latin: Array<string | null>;
  try {
    latin = await romanizer(captions.map((c) => c.text.trim()), reference);
  } catch (err) {
    console.error("[whisper] romanization failed, using rule-based transliteration:", describeError(err));
    latin = captions.map(() => null);
  }
  // Leading spaces mark word starts for createTikTokStyleCaptions. Words the
  // model skipped, or left in Devanagari, go through the rule-based fallback.
  return captions.map((c, i) => ({
    ...c,
    text: (/^\s/.test(c.text) ? " " : "") + stripAccents(devanagariToHinglish(latin[i] ?? c.text.trim())),
  }));
}

/**
 * Transcribes an already-16kHz-mono WAV file with word-level timestamps.
 * Use `extractAudioSegment` from `./media` to produce a compliant WAV first.
 * `reference` is the video's own caption text for the same stretch; the
 * romanizer uses it to correct words whisper misheard.
 */
export async function transcribeWav(
  wavPath: string,
  { romanizer = romanizeHinglishWords, reference }: { romanizer?: Romanizer | null; reference?: string } = {}
): Promise<Caption[]> {
  try {
    let language = LANGUAGE_OVERRIDE ?? "hi";
    if (!LANGUAGE_OVERRIDE) {
      try {
        const detected = await detectLanguage(wavPath);
        if (!HINDI_FAMILY.has(detected)) language = detected;
      } catch (err) {
        console.error("[whisper] language detection failed, assuming Hindi/English:", describeError(err));
      }
    }
    const hinglish = !LANGUAGE_OVERRIDE && language === "hi";
    const prompt = hinglish ? HINGLISH_PROMPT : null;
    const words = await transcribeWords(wavPath, language as Language, prompt);
    const complete = await fillGaps(wavPath, words, language as Language, prompt);
    return hinglish && romanizer ? await romanize(complete, romanizer, reference) : complete;
  } catch (err) {
    throw new WhisperError(`whisper.cpp transcription failed for "${wavPath}": ${describeError(err)}`, err);
  }
}

/**
 * Safety net for the -sow word split: glues any piece that doesn't start with
 * a space (continuation sub-word or attached punctuation) onto the previous
 * word. The caption overlay puts a gap between every item, so an unmerged
 * piece renders as a word with a gap inside it ("Ay ush mann").
 */
function mergeSubwordTokens(captions: Caption[]): Caption[] {
  const merged: Caption[] = [];
  for (const c of captions) {
    const prev = merged[merged.length - 1];
    // A Devanagari piece never continues a Latin word or the other way round
    // ("reader" + "को" became "readerko").
    const scriptChange = prev && hasDevanagari(c.text) !== hasDevanagari(prev.text.slice(-1));
    if (prev && !/^\s/.test(c.text) && !scriptChange) {
      merged[merged.length - 1] = {
        ...prev,
        text: prev.text + c.text,
        endMs: c.endMs,
        confidence: prev.confidence === null || c.confidence === null ? null : Math.min(prev.confidence, c.confidence),
      };
    } else {
      // The leading space makes it its own word in the caption pages.
      merged.push(scriptChange && !/^\s/.test(c.text) ? { ...c, text: " " + c.text } : c);
    }
  }
  return merged;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
