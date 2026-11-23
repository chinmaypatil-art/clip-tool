/**
 * Builds extra fine-tuning examples from YouTube's "Most replayed" graph:
 * the moments viewers rewatch most become clip picks, flat stretches become
 * "no clip here". Captions only, no video download.
 *
 *   npx tsx scripts/collect-replayed.mts            (channels from storage/training/replayed-channels.txt)
 *   npx tsx scripts/collect-replayed.mts <url> ...  (channel or video links)
 *
 * Writes storage/training/replayed-sft.jsonl, the same format as sft.jsonl.
 * Kept separate so users' own reviews stay the main, trusted set. Re-running
 * skips videos already done. YouTube only shows the graph on very popular
 * videos (about 1 in 8 big podcasts), so pick channels with millions of views.
 */
import path from "path";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import { getYtDlpPath } from "../src/lib/binaries";
import { extractYoutubeTranscript, type TranscriptSegment } from "../src/lib/transcript";
import { buildTranscriptWindows, pickWindowSeconds } from "../src/lib/transcriptWindows";
import { buildWindowClipPrompt } from "../src/lib/providers/types";
import { clipLengthRange } from "../src/lib/clipLength";

const run = promisify(execFile);
const ROOT = path.join(process.cwd(), "storage", "training");
const OUT = path.join(ROOT, "replayed-sft.jsonl");
const VIDEOS_PER_CHANNEL = Number(process.env.VIDEOS_PER_CHANNEL ?? 15);
const MIN_VIEWS = 500_000;
const PEAK = 0.6; // a window whose best moment reaches this is a pick
const FLAT = 0.3; // a window that never gets above this is "no clip"
const OLLAMA = "http://127.0.0.1:11434/api/chat";
const MODEL = process.env.CLIP_MODEL ?? "gemma3:12b";
const range = clipLengthRange("short");
// Viewers skip past ads, so the moment after a sponsor read often shows up as a replay peak.
const AD = /\b(sponsor|sponsored|brought to you by|promo code|use code|link in (the )?description|download the app|sign up (at|for|today)|% off|free trial|partnered with|tinder|bumble|squarespace|betterhelp|athletic greens|nordvpn|skillshare|audible|ysl|subscribe|comment below|giveaway|win \$?\d|those of you listening|highly requested|slip into the episode|my (team|company) and i)\b/i;

interface Bin { start_time: number; end_time: number; value: number }
interface Info { id: string; title: string; duration: number; view_count?: number; heatmap?: Bin[] }

const ytdlp = async (args: string[]) =>
  (await run(getYtDlpPath(), args, { maxBuffer: 256 * 1024 * 1024, timeout: 5 * 60_000 })).stdout;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Most-viewed videos of a channel (or the video itself), longest first if tied. */
async function videosFrom(url: string): Promise<string[]> {
  if (/watch\?v=|youtu\.be\//.test(url)) return [url];
  const tab = /\/(videos|streams)\/?$/.test(url) ? url : url.replace(/\/$/, "") + "/videos";
  const list = JSON.parse(await ytdlp([tab, "--flat-playlist", "-J", "--playlist-items", "1:300"]));
  return (list.entries as Info[])
    .filter((e) => (e.view_count ?? 0) >= MIN_VIEWS && (e.duration ?? 0) >= 20 * 60)
    .sort((a, b) => (b.view_count ?? 0) - (a.view_count ?? 0))
    .slice(0, VIDEOS_PER_CHANNEL)
    .map((e) => `https://www.youtube.com/watch?v=${e.id}`);
}

const peakIn = (bins: Bin[], from: number, to: number) =>
  bins.filter((b) => b.end_time > from && b.start_time < to).reduce((m, b) => (b.value > m.value ? b : m), { value: 0 } as Bin);

/**
 * The replayed stretch around a peak, grown to the clip length range and
 * snapped to caption lines inside the window. Null if it doesn't fit.
 */
function clipAround(peak: Bin, bins: Bin[], lines: TranscriptSegment[]): { start: number; end: number } | null {
  let lo = bins.indexOf(peak), hi = lo;
  while (lo > 0 && bins[lo - 1].value >= peak.value * 0.7) lo--;
  while (hi < bins.length - 1 && bins[hi + 1].value >= peak.value * 0.7) hi++;
  let start = bins[lo].start_time, end = bins[hi].end_time;
  const grow = Math.max(0, range.minSeconds - (end - start)) / 2;
  start -= grow;
  end += grow;
  const first = [...lines].reverse().find((l) => l.startMs / 1000 <= start + 1) ?? lines[0];
  const last = lines.find((l) => l.endMs / 1000 >= end - 1) ?? lines[lines.length - 1];
  // Start where a sentence starts (up to 20s earlier), so the clip isn't mid-thought.
  // Auto-captions have no punctuation; then the line edge has to do.
  let i = lines.indexOf(first);
  while (i > 0 && !/[.?!]["”']?\s*$/.test(lines[i - 1].text) && first.startMs - lines[i - 1].startMs <= 20_000) i--;
  if (i > 0 && /[.?!]["”']?\s*$/.test(lines[i - 1].text)) start = lines[i].startMs / 1000;
  else start = first.startMs / 1000;
  end = Math.min(last.endMs / 1000, start + range.maxSeconds);
  return end - start >= range.minSeconds ? { start, end } : null;
}

/** Title/description/category for a picked span, written by the local Gemma (same fields Gemma's picks have). */
async function describe(text: string) {
  const res = await fetch(OLLAMA, {
    method: "POST",
    signal: AbortSignal.timeout(5 * 60_000),
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      format: "json",
      messages: [{
        role: "user",
        content: `This is a short-form clip transcript:\n\n${text}\n\nReturn ONLY JSON: {"title": punchy working title, 10 words max, "description": what happens, ONE short sentence, "category": short label like "personal story", "hot take", "advice", "humor"}`,
      }],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const j = JSON.parse((await res.json()).message.content);
  if (![j.title, j.description, j.category].every((v) => typeof v === "string" && v)) throw new Error("bad metadata");
  return j as { title: string; description: string; category: string };
}

async function collect(url: string, done: Set<string>): Promise<number> {
  const info: Info = JSON.parse(await ytdlp([url, "--skip-download", "-J", "--no-playlist"]));
  if (done.has(info.id)) return 0;
  const bins = info.heatmap ?? [];
  if (bins.length < 20) return 0;
  const dir = await mkdtemp(path.join(os.tmpdir(), "replayed-"));
  let lines: TranscriptSegment[];
  try {
    lines = (await extractYoutubeTranscript(url, dir)).segments;
  } finally {
    // Windows sometimes still holds the caption file; a leftover temp folder isn't worth losing the video.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  // The opening is replayed by everyone who restarts the video; it says nothing.
  const usable = bins.filter((b) => b.start_time >= Math.max(60, info.duration * 0.03));
  const rows: string[] = [];
  let picks = 0, empties = 0;
  for (const w of buildTranscriptWindows(lines, pickWindowSeconds(range))) {
    const peak = peakIn(usable, w.startSeconds, w.endSeconds);
    let clips: object[];
    if (peak.value >= PEAK) {
      const span = clipAround(peak, usable, w.segments);
      if (!span) continue;
      const text = w.segments.filter((s) => s.endMs / 1000 > span.start && s.startMs / 1000 < span.end).map((s) => s.text).join(" ");
      if (AD.test(text)) continue;
      const { title, description, category } = await describe(text);
      // The hook is the clip's real opening line, as the pick prompt asks for.
      const hook = text.split(/\s+/).slice(0, 12).join(" ");
      clips = [{ start_time: +span.start.toFixed(1), end_time: +span.end.toFixed(1), title, hook, description, viral_score: Math.round(peak.value * 100), category }];
      picks++;
    } else if (peak.value > 0 && peak.value < FLAT && empties < picks) {
      clips = []; // as many "nothing here" examples as picks, so the model doesn't learn to always pick
      empties++;
    } else continue;
    rows.push(JSON.stringify({
      meta: { source: "most-replayed", videoId: info.id, from: w.startSeconds, to: w.endSeconds },
      messages: [
        { role: "user", content: buildWindowClipPrompt(w.segments, range) },
        { role: "assistant", content: JSON.stringify({ clips }) },
      ],
    }));
  }
  await appendFile(OUT, rows.map((r) => r + "\n").join(""));
  done.add(info.id);
  return rows.length;
}

await mkdir(ROOT, { recursive: true });
let sources = process.argv.slice(2);
if (!sources.length) {
  const file = path.join(ROOT, "replayed-channels.txt");
  sources = (await readFile(file, "utf8")).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}
const done = new Set<string>(
  existsSync(OUT) ? (await readFile(OUT, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l).meta.videoId) : []
);
let total = 0;
for (const source of sources) {
  let videos: string[] = [];
  try {
    videos = await videosFrom(source);
  } catch (err) {
    console.error(`skip ${source}: ${(err as Error).message.split("\n")[0]}`);
  }
  for (const v of videos) {
    try {
      const n = await collect(v, done);
      total += n;
      console.log(`${v}  +${n}  (total ${total})`);
    } catch (err) {
      console.error(`skip ${v}: ${(err as Error).message.split("\n")[0]}`);
    }
    await sleep(5000); // be gentle with YouTube so the live app's downloads don't get blocked
  }
}
console.log(`done: ${total} new examples in ${OUT}`);
