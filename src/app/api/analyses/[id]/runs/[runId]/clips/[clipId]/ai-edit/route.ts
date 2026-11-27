import { NextRequest, NextResponse } from "next/server";
import { analysisDir, loadAnalysis } from "@/lib/analyses";
import { buildAiEditPrompt, emptyOps, clauses, mergeOps, parseAiEdit, ruleEdit, type AiEditOps } from "@/lib/aiEdit";
import { createLimiter } from "@/lib/limit";
import { processSingleton } from "@/lib/processState";
import { ensureOllama } from "@/lib/ollamaHealth";
import { getLocalJsonChat } from "@/lib/providers/registry";
import { CLIP_PICKER } from "@/lib/analysisPipeline";
import { findMomentEnd } from "@/lib/screenClips";
import path from "path";

// "end it properly", "fix the ending", "end when it's over": judged from the picture.
const END_PROPERLY = /\b(end|ending|finish|stop)\b.*\b(properly|proper|right|correctly|clean(ly)?|better|naturally|fix|when|after|over|done)\b|\bfix (the|its) end(ing)?\b/i;

// The same one-at-a-time GPU queue clip picking and Whisper use.
const gpuSlot = processSingleton("gpuSlot", () => createLimiter(1));

/**
 * Ask AI: turns the editor's request into edit operations on the clip's
 * numbered lines or in seconds. Body: { request, sentences: [{text, removed, at}], seconds, start, end }
 * (start/end: the editor's current edges in source seconds).
 * Nothing is saved here; the editor applies the answer to its edit list.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; runId: string; clipId: string }> }
) {
  const { id, runId, clipId } = await params;
  const analysis = await loadAnalysis(id);
  const run = analysis?.runs.find((r) => r.id === runId);
  if (!run?.clips.some((c) => c.id === clipId)) return NextResponse.json({ error: "Clip not found." }, { status: 404 });

  const body = await req.json().catch(() => null);
  const request = typeof body?.request === "string" ? body.request.trim().slice(0, 500) : "";
  const sentences: Array<{ text: string; removed: boolean; at?: number }> = Array.isArray(body?.sentences)
    ? body.sentences.slice(0, 200).map((s: { text?: unknown; removed?: unknown; at?: unknown }) => ({
        text: String(s?.text ?? "").slice(0, 400),
        removed: s?.removed === true,
        at: Number.isFinite(s?.at) ? Number(s.at) : undefined,
      }))
    : [];
  const seconds = Number(body?.seconds) || 60;
  if (!request) return NextResponse.json({ error: "Type what you want changed." }, { status: 400 });

  // Plain commands by rule; whatever is left goes to the model.
  const parts: AiEditOps[] = [];
  const rest: string[] = [];
  for (const c of clauses(request)) {
    const ops = ruleEdit(c, Math.max(1, sentences.length), seconds);
    if (ops) parts.push(ops);
    else rest.push(c);
  }
  // Ending by the picture: the words alone can't tell when a catch or a goal is over.
  const clipStart = Number(body?.start);
  const clipEnd = Number(body?.end);
  const endAsk = rest.findIndex((c) => END_PROPERLY.test(c));
  if (endAsk >= 0 && Number.isFinite(clipStart) && clipEnd > clipStart) {
    try {
      await ensureOllama();
      const source = path.join(analysisDir(id), "source.mp4");
      const found = await gpuSlot(() => findMomentEnd(source, clipStart, clipEnd, CLIP_PICKER.model));
      if (found) {
        rest.splice(endAsk, 1);
        parts.push({ ...emptyOps(), endAt: found.end - clipStart, reply: `Looked at the picture: now ends ${found.why}.` });
      }
    } catch (err) {
      console.error("[ai-edit] frame check failed:", err);
    }
  }
  if (rest.length && !sentences.length) {
    return NextResponse.json({
      error: "This clip has no speech for the AI to read. Use times instead, like \"end at 0:29\" or \"start 5 seconds earlier\".",
    }, { status: 400 });
  }
  if (rest.length) {
    // Claude's picks have no local model of their own; local Gemma edits them.
    const chat = (await getLocalJsonChat(run.provider, run.model)) ?? (await getLocalJsonChat(CLIP_PICKER.provider, CLIP_PICKER.model));
    if (!chat) return NextResponse.json({ error: "Ask AI needs a local (Ollama) model." }, { status: 400 });
    try {
      await ensureOllama();
      const answer = await gpuSlot(() => chat(buildAiEditPrompt(rest.join(", "), sentences, seconds), 300));
      parts.push(edgesFromCuts(parseAiEdit(answer, sentences.length), sentences));
    } catch (err) {
      console.error("[ai-edit] failed:", err);
      return NextResponse.json({ error: "The AI couldn't do that. Try saying it another way." }, { status: 502 });
    }
  }
  return NextResponse.json(mergeOps(parts));
}

/**
 * The model often "ends it properly" by cutting the last lines out, which
 * leaves the clip's end where it was (a gap, not a new ending). Cuts that
 * reach the last (or first) line still in the clip move that edge instead.
 */
function edgesFromCuts(ops: AiEditOps, sentences: Array<{ removed: boolean }>): AiEditOps {
  const live = sentences.map((s, i) => (s.removed ? 0 : i + 1)).filter(Boolean);
  const cut = new Set(ops.remove);
  let last = live.length - 1;
  while (last >= 0 && cut.has(live[last])) last--;
  let first = 0;
  while (first <= last && cut.has(live[first])) first++;
  if (last < 0 || first > last) return ops;
  const out = { ...ops };
  if (last < live.length - 1 && ops.end === null) out.end = live[last];
  if (first > 0 && ops.start === null) out.start = live[first];
  out.remove = ops.remove.filter((n) => n >= live[first] && n <= live[last]);
  return out;
}
