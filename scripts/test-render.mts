import path from "path";
import { mkdir, copyFile } from "fs/promises";
import { createTikTokStyleCaptions } from "@remotion/captions";
import { extractAudioSegment } from "../src/lib/media";
import { transcribeWav } from "../src/lib/whisper";
import { bundleForJob, renderClip } from "../src/lib/render";

const jobDir = path.join(process.cwd(), "storage", "test-render-job");
await mkdir(jobDir, { recursive: true });
await copyFile("scripts/fixtures/test-video.mp4", path.join(jobDir, "source.mp4"));

const wavPath = path.join(jobDir, "clip-1-audio.wav");
console.log("Extracting audio...");
await extractAudioSegment(path.join(jobDir, "source.mp4"), wavPath, 0, 24);

console.log("Transcribing...");
const t0 = Date.now();
const captions = await transcribeWav(wavPath);
console.log("Transcription took", Date.now() - t0, "ms");
console.log("Captions:", captions.length, "tokens");

const { pages } = createTikTokStyleCaptions({ captions, combineTokensWithinMilliseconds: 1200 });
console.log("Pages:", pages.length);

console.log("Bundling Remotion project...");
const t1 = Date.now();
const serveUrl = await bundleForJob(jobDir);
console.log("Bundle took", Date.now() - t1, "ms:", serveUrl);

console.log("Rendering clip...");
const t2 = Date.now();
await renderClip({
  serveUrl,
  outputPath: path.join(jobDir, "clip-1.mp4"),
  videoFileName: "source.mp4",
  trimStartSeconds: 0,
  durationSeconds: 24,
  title: "Test clip",
  captionPages: pages,
  framing: [],
  onProgress: (p) => process.stdout.write(`\rRender progress: ${Math.round(p * 100)}%`),
});
console.log("\nRender took", Date.now() - t2, "ms");
console.log("Done:", path.join(jobDir, "clip-1.mp4"));
