import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const pager = await ai.models.list();
for await (const model of pager) {
  if (model.supportedActions?.includes("generateContent")) {
    console.log(model.name);
  }
}
