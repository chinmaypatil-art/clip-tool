const CHECK_EVERY_MS = 30_000;

/**
 * Picks up new builds without anyone restarting the server by hand: when
 * `npm run build` writes a new .next/BUILD_ID, this process exits as soon as
 * no job is busy, and start-shared.cmd's loop starts it again on the new build.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;
  const { readFile } = await import("fs/promises");
  const path = await import("path");
  const { listAnalyses } = await import("./lib/analyses");

  const buildIdFile = path.join(process.cwd(), ".next", "BUILD_ID");
  const readBuildId = () => readFile(buildIdFile, "utf8").catch(() => null);
  const running = await readBuildId();

  setInterval(async () => {
    const latest = await readBuildId();
    if (!latest || latest === running) return;
    const busy = (await listAnalyses()).some(
      (a) =>
        a.status === "extracting_transcript" ||
        a.runs.some((r) => r.status === "running" || r.status === "queued" || r.clips.some((c) => c.renderStatus === "rendering"))
    );
    if (busy) return;
    console.log("[update] new build found and no job is running; restarting");
    process.exit(0);
  }, CHECK_EVERY_MS).unref();
}
