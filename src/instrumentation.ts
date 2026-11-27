const CHECK_EVERY_MS = 30_000;

/**
 * Picks up new builds without anyone restarting the server by hand: when
 * `npm run build` writes a finished build to .next-new, this process exits
 * within 30 s unless a job is busy (a download, picking or render would be
 * lost), and start-shared.cmd's loop swaps the build in (scripts/swap-build.mjs)
 * and starts again. The restart takes a few seconds; an open page may need
 * one refresh.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Marks this process as the real server (next start/dev; `next build` never
  // calls register): only it may mark leftover jobs as stopped (lib/analyses).
  process.env.CLIPWISE_SERVER = "1";
  if (process.env.NODE_ENV !== "production") return;
  const { readFile } = await import("fs/promises");
  const path = await import("path");
  const { listAnalyses } = await import("./lib/analyses");

  const newBuild = path.join(process.cwd(), ".next-new", "BUILD_ID");

  // A restart drops a running Claude pick: start it again for videos still waiting.
  const { autoPickWithClaude } = await import("./lib/claudePicker");
  for (const a of await listAnalyses()) if (a.waitingForClaude && !a.archived) autoPickWithClaude(a.id);

  setInterval(async () => {
    if (!(await readFile(newBuild, "utf8").catch(() => null))) return;
    const busy = (await listAnalyses()).some(
      (a) =>
        a.status === "extracting_transcript" ||
        a.runs.some((r) => r.status === "running" || r.status === "queued" || r.clips.some((c) => c.renderStatus === "rendering"))
    );
    if (busy) return;
    console.log("[update] new build found and no job running; restarting");
    process.exit(0);
  }, CHECK_EVERY_MS).unref();
}
