import { downloadWhisperModel, transcribe, toCaptions } from "@remotion/install-whisper-cpp";
import path from "path";

const whisperPath = path.join(process.cwd(), ".whisper-test");
const t0 = Date.now();
await downloadWhisperModel({ model: "base.en", folder: whisperPath, printOutput: true });
console.log("Model download took", Date.now() - t0, "ms");

const t1 = Date.now();
const output = await transcribe({
  model: "base.en",
  whisperPath,
  whisperCppVersion: "1.5.5",
  inputPath: path.join(whisperPath, "speech16k.wav"),
  tokenLevelTimestamps: true,
  printOutput: true,
});
console.log("Transcription took", Date.now() - t1, "ms");
console.log(JSON.stringify(output.transcription, null, 2));

const { captions } = toCaptions({ whisperCppOutput: output });
console.log("CAPTIONS:", JSON.stringify(captions, null, 2));
