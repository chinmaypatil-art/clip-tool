"use client";

import { useEffect, useState } from "react";

const CHECK_EVERY_MS = 60_000;
const RELOADED_KEY = "clipwise-chunk-reload";

/**
 * After an update the server serves a new build, and a page opened before it
 * can't load the new build's code ("page could not load"). A failed chunk
 * reloads the page once; a newer build reloads a page nobody is looking at,
 * and shows a reload button on one that's in use, so no edit is lost.
 */
export function UpdateWatcher() {
  const [updated, setUpdated] = useState(false);

  useEffect(() => {
    let first: string | null = null;
    let stale = false;
    const check = async () => {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const { buildId } = (await res.json()) as { buildId: string };
        if (first === null) first = buildId;
        else if (buildId !== first) stale = true;
      } catch {
        return; // server restarting; try again next time
      }
      if (!stale) return;
      if (document.visibilityState === "hidden") window.location.reload();
      else setUpdated(true);
    };
    const onVisible = () => void (document.visibilityState === "visible" && stale ? window.location.reload() : check());

    const chunkFailed = (message: string) => /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(message);
    const reloadOnce = (message: string) => {
      if (!chunkFailed(message)) return;
      try {
        if (sessionStorage.getItem(RELOADED_KEY)) return;
        sessionStorage.setItem(RELOADED_KEY, "1");
      } catch {}
      window.location.reload();
    };
    const onError = (e: ErrorEvent) => reloadOnce(String(e.message ?? e.error));
    const onRejection = (e: PromiseRejectionEvent) => reloadOnce(String(e.reason?.message ?? e.reason));

    void check();
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    // A page that loaded fine clears the guard for the next update.
    const clear = window.setTimeout(() => {
      try {
        sessionStorage.removeItem(RELOADED_KEY);
      } catch {}
    }, 10_000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(clear);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  if (!updated) return null;
  return (
    <div className="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div className="glass flex items-center gap-3 rounded-full px-4 py-2 text-xs text-zinc-200">
        Clipwise was updated. Save your work, then reload.
        <button onClick={() => window.location.reload()} className="btn-glow rounded-full px-3 py-1 font-medium">
          Reload
        </button>
      </div>
    </div>
  );
}
