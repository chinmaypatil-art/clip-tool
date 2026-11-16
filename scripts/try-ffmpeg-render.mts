// Renders one stretch of an analysis with the ffmpeg renderer, for comparing
// against the Remotion render. Usage: npx tsx scripts/try-ffmpeg-render.mts <analysisId> <start> <seconds> <out.mp4> [captionPreset]
import path from "path";
import { createTikTokStyleCaptions } from "@remotion/captions";
import { analysisDir } from "../src/lib/analyses";
import { analyzeFraming } from "../src/lib/framing";
import { cutClip, extractAudioSegment } from "../src/lib/media";
import { transcribeWav } from "../src/lib/whisper";
import { renderClipFfmpeg } from "../src/lib/ffmpegRender";
import { CAPTION_PRESETS, WORDS_COMBINE_MS } from "../src/lib/captionStyle";

const [id, startArg, lenArg, out, preset = "classic"] = process.argv.slice(2);
const captionStyle = CAPTION_PRESETS[preset].style;
const start = Number(startArg), len = Number(lenArg);
const source = path.join(analysisDir(id), "source.mp4");
const t0 = Date.now();
const segmentPath = `${out}.segment.mp4`, wav = `${out}.wav`;
await cutClip(source, segmentPath, start, start + len);
const framing = await analyzeFraming(source, start, len);
await extractAudioSegment(source, wav, start, len);
const captions = await transcribeWav(wav, {});
const pages = createTikTokStyleCaptions({ captions, combineTokensWithinMilliseconds: WORDS_COMBINE_MS[captionStyle.words] }).pages;
const t1 = Date.now();
await renderClipFfmpeg({ segmentPath, outputPath: out, durationSeconds: len, captionPages: pages, captionStyle, framing });
console.log(`prep ${((t1 - t0) / 1000).toFixed(1)}s, render ${((Date.now() - t1) / 1000).toFixed(1)}s, shots ${framing.map((f) => f.mode).join(",")}`);
process.exit(0);
