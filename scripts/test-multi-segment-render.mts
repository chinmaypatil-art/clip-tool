// Focused regression test for the "extract all segments before bundling"
// fix: pre-extracts two different segments from the fixture video, bundles
// Remotion ONCE (after extraction, as the pipeline now does), then renders
// both segments from that single bundle. Fails loudly if either 404s like
// the original bug did.
import path from "path";
import { mkdir, rm, stat, copyFile } from "fs/promises";
import { cutClip } from "../src/lib/media";
import { bundleForJob, renderClip } from "../src/lib/render";

const JOB_DIR = path.join(process.cwd(), "storage", "jobs", "test-multi-segment");
const FIXTURE = path.join(process.cwd(), "scripts", "fixtures", "test-video-long.mp4");

async function main() {
  await rm(JOB_DIR, { recursive: true, force: true });
  await mkdir(JOB_DIR, { recursive: true });

  const sourcePath = path.join(JOB_DIR, "source.mp4");
  await copyFile(FIXTURE, sourcePath);

  const segments = [
    { filename: "clip-1-segment.mp4", start: 0, end: 10 },
    { filename: "clip-2-segment.mp4", start: 20, end: 33 },
    { filename: "clip-3-segment.mp4", start: 40, end: 50 },
  ];

  console.log("Extracting segments...");
  for (const s of segments) {
    await cutClip(sourcePath, path.join(JOB_DIR, s.filename), s.start, s.end);
    console.log(`  extracted ${s.filename}`);
  }

  console.log("Bundling Remotion (once, after all segments exist)...");
  const serveUrl = await bundleForJob(JOB_DIR);

  console.log("Rendering clips from the single bundle...");
  for (const s of segments) {
    const outPath = path.join(JOB_DIR, s.filename.replace("-segment", ""));
    await renderClip({
      serveUrl,
      outputPath: outPath,
      videoFileName: s.filename,
      trimStartSeconds: 0,
      durationSeconds: s.end - s.start,
      title: "test",
      captionPages: [],
      framing: [],
    });
    const st = await stat(outPath);
    if (st.size === 0) throw new Error(`${outPath} rendered but is empty`);
    console.log(`  OK ${s.filename} -> ${path.basename(outPath)} (${st.size} bytes)`);
  }

  console.log("\nPASS: all segments rendered successfully from one bundle.");
  await rm(JOB_DIR, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
