"use client";

import { useState } from "react";
import { Check, Loader2, ThumbsDown, ThumbsUp } from "lucide-react";
import { GOOD_REASONS, REJECT_REASONS, type ClipReview, type ReviewReason } from "@/lib/review";
import { cn } from "./format";

/**
 * One-tap clip feedback: like/dislike saves at once, then optional tags and
 * a note. Every change is saved straight away, so nothing is lost if the
 * reviewer just closes the page.
 */
export function QuickFeedback({
  url,
  review,
  onSaved,
}: {
  /** The clip's PATCH endpoint. */
  url: string;
  review?: ClipReview;
  onSaved: () => void;
}) {
  const [verdict, setVerdict] = useState(review?.verdict ?? null);
  const [reasons, setReasons] = useState<ReviewReason[]>(review?.reasons ?? []);
  const [note, setNote] = useState(review?.note ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const save = async (next: { verdict: "good" | "bad"; reasons: ReviewReason[]; note: string }) => {
    setState("saving");
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ review: next }),
      });
      if (!res.ok) throw new Error();
      setState("saved");
      onSaved();
    } catch {
      setState("error");
    }
  };

  const pick = (v: "good" | "bad") => {
    // Tags belong to one verdict, so switching starts them fresh.
    const nextReasons = v === verdict ? reasons : [];
    setVerdict(v);
    setReasons(nextReasons);
    void save({ verdict: v, reasons: nextReasons, note });
  };

  const toggle = (r: ReviewReason) => {
    if (!verdict) return;
    const next = reasons.includes(r) ? reasons.filter((x) => x !== r) : [...reasons, r];
    setReasons(next);
    void save({ verdict, reasons: next, note });
  };

  const saveNote = () => {
    if (verdict && note !== (review?.note ?? "")) void save({ verdict, reasons, note });
  };

  const tags = verdict === "good" ? GOOD_REASONS : verdict === "bad" ? REJECT_REASONS : null;

  return (
    <div className="mt-3 space-y-2 border-t border-white/[0.06] pt-2.5">
      <div className="flex items-center gap-1">
        <span className="mr-auto text-[11px] text-zinc-500">{verdict ? "Your rating" : "Rate this clip"}</span>
        <button
          onClick={() => pick("good")}
          title="Good clip"
          className={cn(
            "flex h-7 items-center gap-1 rounded-md px-2 text-[11px] transition",
            verdict === "good" ? "bg-emerald-500 text-white" : "text-zinc-400 hover:bg-emerald-500/15 hover:text-emerald-200"
          )}
        >
          <ThumbsUp size={12} /> Good
        </button>
        <button
          onClick={() => pick("bad")}
          title="Bad clip"
          className={cn(
            "flex h-7 items-center gap-1 rounded-md px-2 text-[11px] transition",
            verdict === "bad" ? "bg-red-500 text-white" : "text-zinc-400 hover:bg-red-500/15 hover:text-red-200"
          )}
        >
          <ThumbsDown size={12} /> Bad
        </button>
      </div>

      {tags && (
        <>
          <p className="text-[11px] text-zinc-500">{verdict === "good" ? "What was good? (tap any)" : "What was wrong? (tap any)"}</p>
          <div className="flex flex-wrap gap-1">
            {(Object.entries(tags) as [ReviewReason, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => toggle(key)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px] transition",
                  reasons.includes(key)
                    ? verdict === "good"
                      ? "border-emerald-400/60 bg-emerald-500/20 text-emerald-100"
                      : "border-red-400/60 bg-red-500/20 text-red-100"
                    : "border-white/10 text-zinc-400 hover:border-white/25 hover:text-zinc-200"
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={saveNote}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            maxLength={500}
            placeholder="Anything else? (optional)"
            className="w-full rounded-lg glass px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-white/25 focus:outline-none"
          />
        </>
      )}

      <p className={cn("text-[10px] text-zinc-500", state === "idle" ? "hidden" : "h-3")}>
        {state === "saving" && (
          <span className="flex items-center gap-1">
            <Loader2 size={10} className="animate-spin" /> Saving
          </span>
        )}
        {state === "saved" && (
          <span className="flex items-center gap-1 text-emerald-400/80">
            <Check size={10} /> Saved
          </span>
        )}
        {state === "error" && <span className="text-red-400">Couldn&apos;t save. Try again.</span>}
      </p>
    </div>
  );
}
