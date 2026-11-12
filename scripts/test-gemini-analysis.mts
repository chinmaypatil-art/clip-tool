import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { uploadVideo, analyzeWindow, rankCandidates } from "../src/lib/gemini";
import { validateClips } from "../src/lib/validation";
import { probeVideo } from "../src/lib/media";
import { clipLengthRange } from "../src/lib/clipLength";

const range = clipLengthRange(undefined);

const videoPath = "scripts/fixtures/test-video.mp4";
const probe = await probeVideo(videoPath);
console.log("Probed duration:", probe.durationSeconds);

console.log("Uploading to Gemini...");
const file = await uploadVideo(videoPath, "video/mp4");
console.log("Upload state:", file.state, file.uri);

console.log("Analyzing full window...");
const candidates = await analyzeWindow(file, 0, probe.durationSeconds, range);
console.log("Raw candidates:", JSON.stringify(candidates, null, 2));

const withAbsolute = candidates.map((c) => ({ ...c, absoluteStart: c.startSeconds, absoluteEnd: c.endSeconds }));
const ranked = await rankCandidates(withAbsolute, 2, range);
console.log("Ranked:", JSON.stringify(ranked, null, 2));

const validated = validateClips(ranked, probe.durationSeconds, range);
console.log("Validated:", JSON.stringify(validated, null, 2));
