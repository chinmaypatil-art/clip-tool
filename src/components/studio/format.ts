/** 754.3 -> "12:34", 3725 -> "1:02:05". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "2 min ago", "Yesterday", "12 Nov". */
export function when(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 172_800_000) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The source link opened at `seconds`, for YouTube; null otherwise. */
export function linkAt(sourceUrl: string | undefined, seconds: number): string | null {
  if (!sourceUrl || !/youtu\.?be/i.test(sourceUrl)) return null;
  try {
    const u = new URL(sourceUrl);
    u.searchParams.delete("si");
    u.searchParams.set("t", `${Math.floor(seconds)}s`);
    return u.toString();
  } catch {
    return null;
  }
}

export const cn = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");
