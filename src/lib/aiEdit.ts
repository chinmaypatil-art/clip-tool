/**
 * Ask AI in the clip editor (the Eddie way): the user types what they want
 * and gets edit operations, which the editor applies to its edit list (so
 * they can be undone).
 *
 * Plain commands (hook, captions, ums, pauses, layout, "end at 0:29", "start
 * 5 seconds earlier") are handled by rules: untuned gemma3:12b turned "turn
 * off the hook" into cutting sentences. Times work in any language, even
 * captions with no punctuation (Marathi, Hinglish). The model only decides
 * content: which lines to cut, where to start or end.
 */
export interface AiEditOps {
  remove: number[];
  restore: number[];
  /** Line numbers to start/end at. */
  start: number | null;
  end: number | null;
  /** New edges in seconds from the clip's current start (start may be negative: earlier). */
  startAt: number | null;
  endAt: number | null;
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
  startAt: null,
  endAt: null,
  hook: null,
  pauses: null,
  fillers: null,
  captions: null,
  layout: [],
  reply: "",
});

const OFF = /\b(off|no|remove|hide|disable|without|drop|kill|turn off)\b/;
const UNIT = String.raw`\s*(?:s|secs?|seconds?)\b`;

export const mmss = (t: number) => `${Math.floor(Math.max(0, t) / 60)}:${String(Math.round(Math.max(0, t) % 60)).padStart(2, "0")}`;

/**
 * Edges by time, the way people say them: "end at 0:29", "end at 29 sec",
 * "start 5 seconds earlier", "end 3 s later", "keep the first 30 seconds".
 */
function timeEdit(c: string, seconds: number): AiEditOps | null {
  if (/\bsentences?\b|\blines?\b/.test(c)) return null;
  const ops = emptyOps();
  const edge = /\b(start|begin|open)/.test(c) ? "start" : /\b(end|finish|stop)/.test(c) ? "end" : null;

  const shift = c.match(new RegExp(String.raw`(\d+(?:\.\d+)?)${UNIT}\s*(earlier|sooner|before|later|after|more|longer|less|shorter)`));
  if (edge && shift) {
    const back = /earlier|sooner|before/.test(shift[2]) || (edge === "end" && /less|shorter/.test(shift[2])) || (edge === "start" && /more|longer/.test(shift[2]));
    const n = Number(shift[1]) * (back ? -1 : 1);
    if (edge === "start") ops.startAt = n;
    else ops.endAt = seconds + n;
    ops.reply = `${edge === "start" ? "Starts" : "Ends"} ${Math.abs(n)} s ${n < 0 ? "earlier" : "later"}.`;
    return ops;
  }

  const at = c.match(new RegExp(String.raw`\b(?:at|on|by|to|around)\s+(?:(\d+):(\d{1,2})|(\d+(?:\.\d+)?)(${UNIT})?)`));
  if (edge && at) {
    const t = at[1] ? Number(at[1]) * 60 + Number(at[2]) : Number(at[3]);
    if (edge === "end" && t > 1) {
      ops.endAt = t;
      ops.reply = `Now ends at ${mmss(t)} (was ${mmss(seconds)}).`;
      return ops;
    }
    if (edge === "start" && t < seconds - 1) {
      ops.startAt = t;
      ops.reply = `Now starts at what was ${mmss(t)}.`;
      return ops;
    }
  }

  const first = c.match(new RegExp(String.raw`\b(?:keep|only|just)\b.*?\bfirst\s+(\d+)${UNIT}`)) ?? c.match(new RegExp(String.raw`\bfirst\s+(\d+)${UNIT}\s*only`));
  if (first) {
    ops.endAt = Number(first[1]);
    ops.reply = `Kept the first ${first[1]} s (was ${mmss(seconds)}).`;
    return ops;
  }
  return null;
}

/** One clause handled by rules, or null when it needs the model. */
export function ruleEdit(clause: string, count: number, seconds = 60): AiEditOps | null {
  const c = clause.toLowerCase();
  const timed = timeEdit(c, seconds);
  if (timed) return timed;
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
    ops.reply = `${name} for ${nums.length ? `lines ${Math.min(from, to)}–${Math.max(from, to)}` : "the whole clip"}.`;
  } else if (nums.length === 1 && /\b(start|begin|open)\b/.test(c) && /\b(sentence|line)\b/.test(c)) {
    ops.start = nums[0];
    ops.reply = `Starts at line ${nums[0]}.`;
  } else if (nums.length === 1 && /\b(end|finish|stop)\b/.test(c) && /\b(sentence|line)\b/.test(c)) {
    ops.end = nums[0];
    ops.reply = `Ends at line ${nums[0]}.`;
  } else if (nums.length && /\b(cut|remove|delete|drop)\b/.test(c) && /\b(sentences?|lines?)\b/.test(c) && !/\b(seconds?|secs?)\b/.test(c)) {
    const [a, b] = /\b(to|through|-|–)\b|-/.test(c) && nums.length === 2 ? [Math.min(...nums), Math.max(...nums)] : [0, -1];
    ops.remove = a ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : nums;
    ops.reply = `Cut line${ops.remove.length > 1 ? "s" : ""} ${ops.remove.join(", ")}.`;
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
    for (const k of ["start", "end", "startAt", "endAt", "hook", "pauses", "fillers", "captions"] as const) if (p[k] !== null) (out[k] as unknown) = p[k];
  }
  out.reply = parts.map((p) => p.reply).filter(Boolean).join(" ");
  return out;
}

/** The model's part: which lines to cut or bring back, and where to start/end. */
export function buildAiEditPrompt(request: string, sentences: Array<{ text: string; removed: boolean; at?: number }>, seconds: number): string {
  const lines = sentences.map((s, i) => `[${i + 1}]${s.at !== undefined ? ` ${mmss(s.at)}` : ""}${s.removed ? " (CUT)" : ""} ${s.text}`).join("\n");
  return `You edit a short vertical video clip (Reels/Shorts), currently ${mmss(seconds)} long. Its transcript, one numbered line each with the time it starts in the clip ("(CUT)" = already removed). Lines may be in any language or a mix of languages:

${lines}

The editor asks: "${request.replace(/"/g, "'")}"

Do exactly what was asked, nothing more:
- "remove": line numbers to cut out. "restore": cut lines to bring back.
- "start" / "end": the line number the clip should now start / end at, or null to keep. Use these (not "remove") to move the start or end.
- "reply": one short sentence telling the editor what you changed. If the request can't be done from these lines, change nothing and say why in "reply".
To shorten to a length, use the times: end at the last line that fits, or cut the least important lines, so the clip still makes sense.

Examples:
"cut the bit about his dad" -> {"remove": [7, 8], "restore": [], "start": null, "end": null, "reply": "Cut the part about his dad (7-8)."}
"start at the question about music" -> {"remove": [], "restore": [], "start": 5, "end": null, "reply": "Now starts at the music question."}
"end it properly" / "fix the ending" -> set "end" to the line where the last point or action is finished, before any new topic or trailing line: {"remove": [], "restore": [], "start": null, "end": 9, "reply": "Now ends where his point lands (9)."}

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
