import { installWhisperCpp } from "@remotion/install-whisper-cpp";
import path from "path";

const whisperPath = path.join(process.cwd(), ".whisper-test");
console.log("Installing whisper.cpp to", whisperPath);
const result = await installWhisperCpp({ to: whisperPath, version: "1.5.5", printOutput: true });
console.log("Install result:", result);
