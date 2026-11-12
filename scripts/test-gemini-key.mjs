import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
try {
  const res = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: "Reply with exactly: OK" }] }],
  });
  console.log("SUCCESS:", res.text);
} catch (err) {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
}
