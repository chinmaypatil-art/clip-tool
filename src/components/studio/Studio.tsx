"use client";

import { useCallback, useEffect, useState } from "react";
import { Scissors } from "lucide-react";
import { CreateView } from "./CreateView";
import { ProjectView } from "./ProjectView";
import { LibraryView } from "./LibraryView";
import { cn } from "./format";

type View = { kind: "create" } | { kind: "library" } | { kind: "project"; id: string };

// The view lives in the URL hash, so reload and the back button keep your place.
function parseHash(hash: string): View {
  const project = hash.match(/^#\/video\/([\w-]+)$/);
  if (project) return { kind: "project", id: project[1] };
  if (hash === "#/library") return { kind: "library" };
  return { kind: "create" };
}
const hashOf = (v: View) => (v.kind === "project" ? `#/video/${v.id}` : v.kind === "library" ? "#/library" : "#/");

export default function Studio() {
  const [view, setView] = useState<View>({ kind: "create" });

  useEffect(() => {
    const sync = () => setView(parseHash(window.location.hash));
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const go = useCallback((v: View) => {
    window.location.hash = hashOf(v);
    window.scrollTo({ top: 0 });
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-zinc-950/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <button onClick={() => go({ kind: "create" })} className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white text-zinc-900">
              <Scissors size={14} strokeWidth={2.5} />
            </span>
            <span className="text-sm font-semibold tracking-tight">Clipwise</span>
          </button>
          <nav className="flex gap-1 text-sm">
            {(
              [
                ["create", "New"],
                ["library", "Library"],
              ] as const
            ).map(([kind, label]) => (
              <button
                key={kind}
                onClick={() => go({ kind })}
                className={cn(
                  "rounded-lg px-3 py-1.5 transition",
                  view.kind === kind ? "bg-white/10 text-white" : "text-zinc-500 hover:text-zinc-200"
                )}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {view.kind === "create" && <CreateView onStarted={(id) => go({ kind: "project", id })} />}
      {view.kind === "library" && <LibraryView onOpen={(id) => go({ kind: "project", id })} />}
      {view.kind === "project" && <ProjectView key={view.id} id={view.id} onBack={() => window.history.back()} />}
    </div>
  );
}
