import { NextRequest, NextResponse } from "next/server";
import { loadAnalysis } from "@/lib/analyses";
import { buildAiEditPrompt, clauses, mergeOps, parseAiEdit, ruleEdit, type AiEditOps } from "@/lib/aiEdit";
import { createLimiter } from "@/lib/limit";
import { processSingleton } from "@/lib/processState";
import { ensureOllama } from "@/lib/ollamaHealth";
import { getLocalJsonChat } from "@/lib/providers/registry";

// The same one-at-a-time GPU queue clip picking and Whisper use.
const gpuSlot = processSingleton("gpuSlot", () => createLimiter(1));

/**
 * Ask AI: turns the editor's request into edit operations on the clip's
 * numbered sentences. Body: { request, sentences: [{text, removed}], seconds }.
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
  const sentences: Array<{ text: string; removed: boolean }> = Array.isArray(body?.sentences)
    ? body.sentences.slice(0, 200).map((s: { text?: unknown; removed?: unknown }) => ({ text: String(s?.text ?? "").slice(0, 400), removed: s?.removed === true }))
    : [];
  if (!request || !sentences.length) return NextResponse.json({ error: "Type what you want changed." }, { status: 400 });

  // Plain commands by rule; whatever is left goes to the model.
  const parts: AiEditOps[] = [];
  const rest: string[] = [];
  for (const c of clauses(request)) {
    const ops = ruleEdit(c, sentences.length);
    if (ops) parts.push(ops);
    else rest.push(c);
  }
  if (rest.length) {
    const chat = await getLocalJsonChat(run.provider, run.model);
    if (!chat) return NextResponse.json({ error: "Ask AI needs a local (Ollama) model." }, { status: 400 });
    try {
      await ensureOllama();
      const answer = await gpuSlot(() => chat(buildAiEditPrompt(rest.join(", "), sentences, Number(body.seconds) || 60), 300));
      parts.push(parseAiEdit(answer, sentences.length));
    } catch (err) {
      console.error("[ai-edit] failed:", err);
      return NextResponse.json({ error: "The AI couldn't do that. Try saying it another way." }, { status: 502 });
    }
  }
  return NextResponse.json(mergeOps(parts));
}
