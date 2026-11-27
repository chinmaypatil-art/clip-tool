import { NextRequest, NextResponse } from "next/server";
import { loadAnalysis } from "@/lib/analyses";
import { addPickedClips, isSubject, runModelAgainstAnalysis, type PickedClip } from "@/lib/analysisPipeline";
import { getProvider } from "@/lib/providers/registry";
import { DEFAULT_CLIP_LENGTH, isClipLengthPreset } from "@/lib/clipLength";

/** Starts one or more model runs against this analysis's existing transcript — never re-extracts it. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const analysis = await loadAnalysis(id);
  if (!analysis) return NextResponse.json({ error: "Analysis not found (or not yet loaded into memory)." }, { status: 404 });
  if (analysis.status !== "ready") {
    return NextResponse.json({ error: `Analysis is not ready yet (status: ${analysis.status}).` }, { status: 409 });
  }

  const body = await req.json().catch(() => null);
  if (Array.isArray(body?.clips)) return savePickedClips(id, analysis.videoDurationSeconds ?? Infinity, body);
  const requests = body?.models;
  if (!Array.isArray(requests) || requests.length === 0) {
    return NextResponse.json({ error: "Provide `models`: [{provider, model}, ...]." }, { status: 400 });
  }

  for (const r of requests) {
    if (typeof r?.provider !== "string" || !(await getProvider(r.provider)) || typeof r?.model !== "string") {
      return NextResponse.json({ error: "Each entry needs a valid provider and model." }, { status: 400 });
    }
  }

  // Fire all requested runs concurrently (capped by the small number a user
  // would realistically select at once) — each is independent and tracked
  // via its own ModelRun record.
  const clipLength = isClipLengthPreset(body?.clipLength) ? body.clipLength : DEFAULT_CLIP_LENGTH;
  for (const r of requests) {
    void runModelAgainstAnalysis(id, r.provider, r.model, clipLength);
  }

  return NextResponse.json({ ok: true, started: requests.length });
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** Clips chosen by watching the video (Claude over MCP): checked and saved as a run for the user to render. */
async function savePickedClips(id: string, duration: number, body: { clips: unknown[]; picker?: unknown }) {
  const clips: PickedClip[] = [];
  for (const raw of body.clips.slice(0, 10)) {
    const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const start = num(c.startSeconds);
    const end = num(c.endSeconds);
    if (start === null || end === null || start < 0 || end > duration + 1 || end - start < 5 || end - start > 300) {
      return NextResponse.json({ error: "Each clip needs startSeconds < endSeconds, 5-300 s long, inside the video." }, { status: 400 });
    }
    const hookStart = num(c.hookStartSeconds);
    const hookEnd = num(c.hookEndSeconds);
    const hookOk = hookStart !== null && hookEnd !== null && hookStart >= start && hookEnd <= end && hookEnd - hookStart >= 1 && hookEnd - hookStart <= 8;
    clips.push({
      startSeconds: start,
      endSeconds: Math.min(end, duration),
      title: str(c.title, 120) || "Untitled",
      hook: str(c.hook, 300),
      description: str(c.description, 600),
      reasoning: str(c.reasoning, 600),
      viralScore: Math.min(100, Math.max(0, num(c.viralScore) ?? 50)),
      category: str(c.category, 40) || "moment",
      engagementPotential: "",
      ...(hookOk ? { hookStartSeconds: hookStart, hookEndSeconds: hookEnd } : {}),
      ...(isSubject(c.subject) ? { subject: c.subject } : {}),
    });
  }
  if (!clips.length) return NextResponse.json({ error: "No clips given." }, { status: 400 });
  const runId = addPickedClips(id, str(body.picker, 60) || "mcp", clips);
  return NextResponse.json({ ok: true, runId, saved: clips.length });
}
