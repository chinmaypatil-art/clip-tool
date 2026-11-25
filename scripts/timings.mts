// How long each step took, per video (newest first): npx tsx scripts/timings.mts [count]
import { readdirSync, readFileSync, existsSync } from "node:fs";

const root = "storage/analyses";
const m = (ms?: number) => (ms === undefined || !Number.isFinite(ms) ? "   -  " : `${(ms / 60000).toFixed(1).padStart(5)}m`);
const rows = readdirSync(root)
  .filter((d) => existsSync(`${root}/${d}/analysis.json`))
  .map((d) => JSON.parse(readFileSync(`${root}/${d}/analysis.json`, "utf8")))
  .filter((a) => a.oneClick)
  .sort((a, b) => b.createdAt - a.createdAt)
  .slice(0, Number(process.argv[2] ?? 15));

console.log("video                          length  download transcr  picking  render   total  clips");
for (const a of rows) {
  const run = a.runs.at(-1);
  const clips = run?.clips ?? [];
  const finished = clips.map((c: { renderFinishedAt?: number }) => c.renderFinishedAt).filter(Boolean);
  const renderEnd = finished.length === clips.length && clips.length ? Math.max(...finished) : undefined;
  console.log(
    `${(a.title ?? a.id).slice(0, 30).padEnd(30)} ${m((a.videoDurationSeconds ?? NaN) * 1000)}  ` +
      `${m(a.downloadedAt - a.createdAt)}  ${m(a.transcriptReadyAt - a.downloadedAt)}  ${m(run?.finishedAt - run?.startedAt)}  ` +
      `${m(renderEnd && renderEnd - run.finishedAt)}  ${m(renderEnd && renderEnd - a.createdAt)}  ${finished.length}/${clips.length}`
  );
}
