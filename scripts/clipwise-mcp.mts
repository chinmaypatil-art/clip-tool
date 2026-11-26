// Clipwise MCP server: lets Claude (or any MCP client) look at rendered clips
// and leave reviews. Run by the client: node scripts/clipwise-mcp.mts
// Reads storage/ directly, so the Clipwise app does not need to be running.
// AI reviews go to storage/training/ai-reviews.jsonl, never into analysis.json,
// so they can't clash with the app's own writes or mix with human labels.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getFfmpegPath } from "../src/lib/binaries.ts";
import { REJECT_REASONS, GOOD_REASONS } from "../src/lib/review.ts";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const ANALYSES = path.join(ROOT, "storage", "analyses");
const AI_REVIEWS = path.join(ROOT, "storage", "training", "ai-reviews.jsonl");
const RUBRIC = await readFile(path.join(import.meta.dirname, "clip-review-rubric.md"), "utf8");

interface Clip {
  id: string; title: string; hook?: string; description?: string; reasoning?: string;
  startSeconds: number; endSeconds: number; renderStatus: string; renderError?: string; renderFilename?: string; review?: { verdict: string; reasons: string[]; note: string };
}
interface Analysis {
  id: string; createdAt: number; status: string; error: string | null; title?: string; sourceLabel: string; archived?: boolean; focus?: string; videoDurationSeconds: number | null;
  transcript: { segments: { startMs: number; endMs: number; text: string }[] } | null;
  runs: { id: string; provider: string; model: string; status: string; error: string | null; clips: Clip[] }[];
}

async function loadAll(): Promise<Analysis[]> {
  const out: Analysis[] = [];
  for (const id of await readdir(ANALYSES).catch(() => [])) {
    try { out.push(JSON.parse(await readFile(path.join(ANALYSES, id, "analysis.json"), "utf8"))); } catch { /* half-written or not an analysis */ }
  }
  return out;
}

async function load(analysisId: string): Promise<Analysis> {
  if (!/^[\w-]+$/.test(analysisId)) throw new Error("Bad analysisId");
  return JSON.parse(await readFile(path.join(ANALYSES, analysisId, "analysis.json"), "utf8"));
}

function findClip(a: Analysis, clipId: string) {
  for (const r of a.runs) for (const c of r.clips) if (c.id === clipId) return { run: r, clip: c };
  throw new Error(`No clip ${clipId} in ${a.id}`);
}

const renderPath = (a: Analysis, c: Clip) => (c.renderFilename ? path.join(ANALYSES, a.id, path.basename(c.renderFilename)) : null);

function transcriptBetween(a: Analysis, start: number, end: number): string {
  return (a.transcript?.segments ?? [])
    .filter((s) => s.endMs / 1000 > start && s.startMs / 1000 < end)
    .map((s) => `[${(s.startMs / 1000).toFixed(1)}] ${s.text}`)
    .join("\n");
}

async function aiReviews(): Promise<{ analysisId: string; clipId?: string; reviewer: string }[]> {
  const text = await readFile(AI_REVIEWS, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function duration(file: string): Promise<number> {
  // ffmpeg prints "Duration: 00:00:42.10" to stderr and exits non-zero without an output.
  const err = await run(getFfmpegPath(), ["-i", file]).then(() => "", (e) => String(e.stderr));
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
  if (!m) throw new Error(`Can't read duration of ${file}`);
  return +m[1] * 3600 + +m[2] * 60 + +m[3];
}

/** Grid of evenly spaced frames (row by row) plus the times they were taken at. */
async function contactSheet(file: string, cols: number, rows: number, width: number) {
  const dur = await duration(file);
  const n = cols * rows;
  const dir = await mkdtemp(path.join(os.tmpdir(), "clipwise-mcp-"));
  try {
    const out = path.join(dir, "sheet.jpg");
    await run(getFfmpegPath(), ["-v", "error", "-i", file, "-vf", `fps=${n}/${dur},scale=${width}:-2,tile=${cols}x${rows}`, "-frames:v", "1", "-q:v", "4", out]);
    const times = Array.from({ length: n }, (_, i) => ((i + 0.5) * dur) / n);
    return { data: (await readFile(out)).toString("base64"), times, dur };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function frameAt(file: string, t: number, width: number) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "clipwise-mcp-"));
  try {
    const out = path.join(dir, "f.jpg");
    await run(getFfmpegPath(), ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "3", out]);
    return (await readFile(out)).toString("base64");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const img = (data: string) => ({ type: "image" as const, data, mimeType: "image/jpeg" });
const txt = (text: string) => ({ type: "text" as const, text });
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

const server = new McpServer(
  { name: "clipwise", version: "0.1.0" },
  { instructions: `Clipwise clip reviewer. Workflow: make_clips(url) -> get_progress until DONE -> list_clips -> get_clip_pack -> submit_review for each clip. Your reviews never replace the human's; they are stored separately. Be efficient: get_progress waits by itself, so call it, not a polling loop; fetch each clip pack once and submit right after judging it; keep notes to one line. Judge every clip with this rubric:\n\n${RUBRIC}` }
);

server.registerTool("list_clips", {
  description: "Rendered clips, newest videos first. Shows the human review (if any) and which AI reviewers already reviewed each clip.",
  inputSchema: { analysisId: z.string().optional().describe("Only this video's clips"), onlyNotReviewedBy: z.string().optional().describe("Reviewer name, e.g. 'claude-opus-5-5'; hides clips this reviewer already did"), limit: z.number().int().min(1).max(200).default(30) },
}, async ({ analysisId, onlyNotReviewedBy, limit }) => {
  const done = await aiReviews();
  const lines: string[] = [];
  for (const a of (await loadAll()).filter((a) => !a.archived && (!analysisId || a.id === analysisId)).sort((x, y) => y.createdAt - x.createdAt)) {
    for (const r of a.runs) for (const c of r.clips) {
      const file = renderPath(a, c);
      if (!file || !existsSync(file)) continue;
      const by = done.filter((d) => d.analysisId === a.id && d.clipId === c.id).map((d) => d.reviewer);
      if (onlyNotReviewedBy && by.includes(onlyNotReviewedBy)) continue;
      lines.push(`analysisId=${a.id} clipId=${c.id} | ${a.title ?? a.sourceLabel} | "${c.title}" ${fmt(c.startSeconds)}-${fmt(c.endSeconds)} | picker=${r.model} | human=${c.review?.verdict ?? "none"} | ai=${by.join(",") || "none"}`);
    }
  }
  return { content: [txt(lines.slice(0, limit).join("\n") || "No rendered clips match.")] };
});

server.registerTool("get_clip_pack", {
  description: "Everything needed to review one rendered clip: the picker's reasons, transcript (with source-video times), a contact sheet of the clip as rendered (vertical, with captions), and the first, middle and last frames.",
  inputSchema: { analysisId: z.string(), clipId: z.string() },
}, async ({ analysisId, clipId }) => {
  const a = await load(analysisId);
  const { run: r, clip: c } = findClip(a, clipId);
  const file = renderPath(a, c);
  if (!file || !existsSync(file)) throw new Error("This clip has no render file; render it in Clipwise first.");
  const sheet = await contactSheet(file, 4, 3, 270);
  const [first, mid, last] = await Promise.all([0.3, sheet.dur / 2, Math.max(0, sheet.dur - 0.5)].map((t) => frameAt(file, t, 540)));
  const transcript = transcriptBetween(a, c.startSeconds - 15, c.endSeconds + 15);
  const info = [
    `Video: ${a.title ?? a.sourceLabel} (${a.videoDurationSeconds ? fmt(a.videoDurationSeconds) : "?"} long)${a.focus ? ` | user asked for: ${a.focus}` : ""}`,
    `Clip "${c.title}" | source ${fmt(c.startSeconds)}-${fmt(c.endSeconds)} | rendered length ${sheet.dur.toFixed(1)}s | picker ${r.provider}/${r.model}`,
    `Hook: ${c.hook ?? "-"}\nDescription: ${c.description ?? "-"}\nPicker's reason: ${c.reasoning ?? "-"}`,
    c.review ? `Human review: ${c.review.verdict} ${c.review.reasons.join(",")} ${c.review.note}` : "Human review: none",
    transcript
      ? `Transcript, 15s either side of the clip (source seconds; clip runs ${c.startSeconds.toFixed(1)}-${c.endSeconds.toFixed(1)}):\n${transcript}`
      : "No transcript (no speech found). Judge from the frames.",
    `Contact sheet: 12 frames, left to right then top to bottom, at clip seconds ${sheet.times.map((t) => t.toFixed(1)).join(", ")}. Then full-size frames at 0.3s, ${(sheet.dur / 2).toFixed(1)}s, ${(sheet.dur - 0.5).toFixed(1)}s.`,
  ].join("\n\n");
  return { content: [txt(info), img(sheet.data), img(first), img(mid), img(last)] };
});

server.registerTool("get_video_overview", {
  description: "Contact sheet of the whole source video plus the list of clips already picked, for spotting good moments the picker missed. Only works while the source video is still on disk.",
  inputSchema: { analysisId: z.string() },
}, async ({ analysisId }) => {
  const a = await load(analysisId);
  const src = path.join(ANALYSES, a.id, "source.mp4");
  if (!existsSync(src)) throw new Error("Source video was deleted after review; no overview possible.");
  const sheet = await contactSheet(src, 6, 6, 240);
  const picked = a.runs.flatMap((r) => r.clips).map((c) => `${fmt(c.startSeconds)}-${fmt(c.endSeconds)} "${c.title}"`);
  return {
    content: [
      txt(`36 frames, row by row, at source times ${sheet.times.map(fmt).join(", ")}.\nAlready picked:\n${picked.join("\n") || "none"}\nUse get_clip_pack for clip detail; transcript is in analysis via the clips. Report gaps with submit_missed_moment.`),
      img(sheet.data),
    ],
  };
});

// The pipeline runs inside the Clipwise app (GPU queue, Whisper, Gemma), so
// new videos go through its API; everything else reads storage/ directly.
const APP = process.env.CLIPWISE_URL ?? "http://127.0.0.1:3000";

async function appCookie(): Promise<string> {
  const env = await readFile(path.join(ROOT, ".env.local"), "utf8").catch(() => "");
  const password = /^APP_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!password) return "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`clipwise:${password}`));
  return `clipwise_access=${Buffer.from(digest).toString("hex")}`;
}

server.registerTool("make_clips", {
  description: "Start Clipwise on a video link (YouTube or direct URL): download, transcribe, pick clips with Gemma and render them all. Returns an analysisId; poll get_progress until done, then review the clips.",
  inputSchema: {
    url: z.string().url(),
    clipCount: z.number().int().min(3).max(10).optional().describe("How many clips to make, 3-10 (default 5). More for long videos with many good moments."),
    clipLength: z.string().optional().describe("Clipwise clip length preset; omit for the default"),
    focus: z.string().max(120).optional().describe("What to look for, e.g. 'funny moments'"),
  },
}, async ({ url, clipCount, clipLength, focus }) => {
  const res = await fetch(`${APP}/api/analyses`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: await appCookie() },
    body: JSON.stringify({ url, oneClick: true, clipCount, clipLength, focus }),
  }).catch(() => { throw new Error(`Clipwise isn't running at ${APP}. Start it first.`); });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Clipwise answered ${res.status}`);
  return { content: [txt(`Started. analysisId=${body.analysisId}. This takes several minutes; call get_progress every minute or two.`)] };
});

server.registerTool("get_progress", {
  description: "Waits (up to waitMinutes) until the video is fully rendered or failed, then says where it is. One call usually covers a whole stage, so don't poll in a loop: call again only if it says still working.",
  inputSchema: { analysisId: z.string(), waitMinutes: z.number().min(0).max(10).default(10) },
}, async ({ analysisId, waitMinutes }) => {
  const until = Date.now() + waitMinutes * 60_000;
  for (;;) {
    const p = await progress(analysisId);
    if (p.final || Date.now() >= until) return { content: [txt(p.final ? p.text : `Still working: ${p.text} Call get_progress again.`)] };
    await new Promise((r) => setTimeout(r, 15_000));
  }
});

async function progress(analysisId: string): Promise<{ text: string; final: boolean }> {
  const a = await load(analysisId).catch(() => null);
  if (!a) return { text: "Starting.", final: false };
  if (a.status === "error") return { text: `Failed: ${a.error}`, final: true };
  if (a.status === "extracting_transcript") return { text: "Downloading and transcribing.", final: false };
  const r = a.runs.at(-1);
  if (!r || r.status === "queued" || r.status === "running") return { text: "Gemma is picking clips.", final: false };
  if (r.status === "error") return { text: `Picking failed: ${r.error}`, final: true };
  const done = r.clips.filter((c) => c.renderStatus === "done").length;
  const failed = r.clips.filter((c) => c.renderStatus === "error");
  const final = done + failed.length === r.clips.length;
  const text = `${done} of ${r.clips.length} clips rendered${failed.length ? `, ${failed.length} failed (${failed[0].renderError})` : ""}.`;
  return { text: final ? `DONE: ${text} Review them with list_clips(analysisId) / get_clip_pack.` : text, final };
}

const reasonKeys =[...Object.keys(REJECT_REASONS), ...Object.keys(GOOD_REASONS)] as [string, ...string[]];
const score = z.number().int().min(1).max(5);

server.registerTool("submit_review", {
  description: "Save your rubric verdict on one clip. Stored separately from human reviews, tagged with your reviewer name.",
  inputSchema: {
    analysisId: z.string(), clipId: z.string(),
    reviewer: z.string().describe("Your model id, e.g. 'claude-opus-5-5'"),
    verdict: z.enum(["good", "bad"]),
    reasons: z.array(z.enum(reasonKeys)).describe(`Bad: ${Object.keys(REJECT_REASONS).join(", ")}. Good: ${Object.keys(GOOD_REASONS).join(", ")}`),
    scores: z.object({ hook: score, payoff: score, cleanStart: score, cleanEnd: score, framing: score, captions: score, visualQuality: score, standsAlone: score }),
    whatHappens: z.string().describe("One or two sentences: what actually happens in the clip, from frames and transcript"),
    betterStartSeconds: z.number().optional().describe("Suggested start, in source-video seconds"),
    betterEndSeconds: z.number().optional().describe("Suggested end, in source-video seconds"),
    note: z.string().describe("Why, in one line"),
  },
}, async (input) => {
  const a = await load(input.analysisId);
  findClip(a, input.clipId);
  await mkdir(path.dirname(AI_REVIEWS), { recursive: true });
  await appendFile(AI_REVIEWS, JSON.stringify({ kind: "clip_review", at: Date.now(), ...input }) + "\n");
  return { content: [txt("Saved.")] };
});

server.registerTool("submit_missed_moment", {
  description: "Report a good moment in the source video that no clip covers.",
  inputSchema: {
    analysisId: z.string(), reviewer: z.string(),
    startSeconds: z.number(), endSeconds: z.number(),
    whatHappens: z.string(), whyGood: z.string(),
  },
}, async (input) => {
  await load(input.analysisId);
  await mkdir(path.dirname(AI_REVIEWS), { recursive: true });
  await appendFile(AI_REVIEWS, JSON.stringify({ kind: "missed_moment", at: Date.now(), ...input }) + "\n");
  return { content: [txt("Saved.")] };
});

await server.connect(new StdioServerTransport());
