/**
 * Ask AI in the clip editor (the Eddie way): the user types what they want
 * and gets edit operations on numbered sentences, which the editor applies to
 * its edit list (so they can be undone).
 *
 * Plain commands (hook, captions, ums, pauses, layout, "end at sentence 20")
 * are handled by rules: untuned gemma3:12b turned "turn off the hook" and
 * "show both people in sentence 3" into cutting sentences. The model only
 * decides content: which sentences to cut, where to start or end.
 */
export interface AiEditOps {
  remove: number[];
  restore: number[];
  start: number | null;
  end: number | null;
  hook: boolean | null;
  pauses: boolean | null;
  fillers: boolean | null;
  captions: boolean | null;
  layout: Array<{ from: number; to: number; mode: "fill" | "wide" | "fit" | "auto" }>;
  reply: string;
}

export const emptyOps = (): AiEditOps => ({
  remove: [],
  restore: [],
  start: null,
  end: null,
  hook: null,
  pauses: null,
  fillers: null,
  captions: null,
  layout: [],
  reply: "",
});

const OFF = /\b(off|no|remove|hide|disable|without|drop|kill|turn off)\b/;

/** One clause handled by rules, or null when it needs the model. */
export function ruleEdit(clause: string, count: number): AiEditOps | null {
  const c = clause.toLowerCase();
  const ops = emptyOps();
  const nums = [...c.matchAll(/\d+/g)].map((m) => Math.min(count, Math.max(1, Number(m[0]))));
  if (/\b(hook|teaser|cold open)\b/.test(c)) {
    ops.hook = !OFF.test(c);
    ops.reply = `Hook-first opening ${ops.hook ? "on" : "off"}.`;
  } else if (/\b(captions?|subtitles?|subs)\b/.test(c) && !/\b(spell|word|typo)\b/.test(c)) {
    ops.captions = !OFF.test(c);
    ops.reply = `Captions ${ops.captions ? "on" : "off"}.`;
  } else if (/\b(u+m+s?|u+h+s?|fillers?|filler words)\b/.test(c)) {
    ops.fillers = true;
    ops.reply = "Filler words removed.";
  } else if (/\b(pauses?|silences?|gaps?|dead air)\b/.test(c)) {
    ops.pauses = !/\b(keep|leave|don'?t)\b/.test(c);
    ops.reply = ops.pauses ? "Long pauses shortened." : "Pauses kept as they are.";
  } else if (/\b(both|everyone|whole frame|full frame|two people|all of them)\b/.test(c) || /\b(zoom out|wide|wider|gestures?|hands)\b/.test(c) || /\b(close[- ]?up|zoom in|closer|automatic framing|auto framing)\b/.test(c)) {
    const mode = /\b(automatic|auto)\b/.test(c) ? "auto" : /\b(close[- ]?up|zoom in|closer)\b/.test(c) ? "fill" : /\b(zoom out|wide|wider|gestures?|hands)\b/.test(c) ? "wide" : "fit";
    const [from, to] = nums.length ? [nums[0], nums[1] ?? nums[0]] : [1, count];
    ops.layout = [{ from: Math.min(from, to), to: Math.max(from, to), mode }];
    const name = { fill: "Close-up", wide: "Wide view", fit: "Whole frame", auto: "Automatic framing" }[mode];
    ops.reply = `${name} for ${nums.length ? `sentences ${Math.min(from, to)}–${Math.max(from, to)}` : "the whole clip"}.`;
  } else if (nums.length === 1 && /\b(start|begin|open)\b/.test(c) && /\bsentence\b/.test(c)) {
    ops.start = nums[0];
    ops.reply = `Starts at sentence ${nums[0]}.`;
  } else if (nums.length === 1 && /\b(end|finish|stop)\b/.test(c) && /\bsentence\b/.test(c)) {
    ops.end = nums[0];
    ops.reply = `Ends at sentence ${nums[0]}.`;
  } else if (nums.length && /\b(cut|remove|delete|drop)\b/.test(c) && /\bsentences?\b/.test(c) && !/\b(seconds?|secs?)\b/.test(c)) {
    const [a, b] = /\b(to|through|-|–)\b|-/.test(c) && nums.length === 2 ? [Math.min(...nums), Math.max(...nums)] : [0, -1];
    ops.remove = a ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : nums;
    ops.reply = `Cut sentence${ops.remove.length > 1 ? "s" : ""} ${ops.remove.join(", ")}.`;
  } else {
    return null;
  }
  return ops;
}

/** Splits "turn off the hook and cut the intro" into clauses for ruleEdit. */
export const clauses = (request: string) =>
  request
    .split(/,|;|\.\s|\band then\b|\band\b|\balso\b/i)
    .map((s) => s.trim())
    .filter(Boolean);

/** Merges clause results; later clauses win for switches, lists add up. */
export function mergeOps(parts: AiEditOps[]): AiEditOps {
  const out = emptyOps();
  for (const p of parts) {
    out.remove.push(...p.remove);
    out.restore.push(...p.restore);
    out.layout.push(...p.layout);
    for (const k of ["start", "end", "hook", "pauses", "fillers", "captions"] as const) if (p[k] !== null) (out[k] as unknown) = p[k];
  }
  out.reply = parts.map((p) => p.reply).filter(Boolean).join(" ");
  return out;
}

/** The model's part: which sentences to cut or bring back, and where to start/end. */
export function buildAiEditPrompt(request: string, sentences: Array<{ text: string; removed: boolean }>, seconds: number): string {
  const lines = sentences.map((s, i) => `[${i + 1}]${s.removed ? " (CUT)" : ""} ${s.text}`).join("\n");
  return `You edit a short vertical video clip (Reels/Shorts), currently about ${Math.round(seconds)} seconds. Its transcript, one numbered sentence per line ("(CUT)" = already removed):

${lines}

The editor asks: "${request.replace(/"/g, "'")}"

Do exactly what was asked, nothing more:
- "remove": sentence numbers to cut out. "restore": cut sentences to bring back.
- "start" / "end": the sentence number the clip should now start / end at, or null to keep. Use these (not "remove") to move the start or end.
- "reply": one short sentence telling the editor what you changed.
To shorten to a length, cut the least important sentences (about 2.5 words per second) so the clip still makes sense.

Examples:
"cut the bit about his dad" -> {"remove": [7, 8], "restore": [], "start": null, "end": null, "reply": "Cut the part about his dad (7-8)."}
"start at the question about music" -> {"remove": [], "restore": [], "start": 5, "end": null, "reply": "Now starts at the music question."}

Return ONLY JSON: {"remove": [], "restore": [], "start": null, "end": null, "reply": ""}`;
}

export function parseAiEdit(jsonText: string, count: number): AiEditOps {
  const o = JSON.parse(jsonText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "")) as Record<string, unknown>;
  const n = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= count ? (v as number) : null);
  const list = (v: unknown) => (Array.isArray(v) ? v.map(n).filter((x): x is number => x !== null) : []);
  return {
    ...emptyOps(),
    remove: list(o.remove),
    restore: list(o.restore),
    start: n(o.start),
    end: n(o.end),
    reply: typeof o.reply === "string" ? o.reply.slice(0, 300) : "",
  };
}
