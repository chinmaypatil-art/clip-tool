import { spawn } from "child_process";
import path from "path";
import { existsSync } from "fs";

const OLLAMA_URL = "http://127.0.0.1:11434/api/version";

async function ollamaUp(): Promise<boolean> {
  try {
    return (await fetch(OLLAMA_URL, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

/**
 * Makes sure Ollama is answering before a job needs Gemma. The start script
 * launches it at boot, but if it has died since, start it again here rather
 * than failing every job until the next reboot.
 */
export async function ensureOllama(): Promise<void> {
  if (await ollamaUp()) return;
  const installed = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Ollama", "ollama.exe");
  const exe = existsSync(installed) ? installed : "ollama";
  console.error("[ollama] not answering; starting it");
  const proc = spawn(exe, ["serve"], { detached: true, stdio: "ignore", windowsHide: true });
  proc.on("error", (err) => console.error("[ollama] could not start:", err.message));
  proc.unref();
  for (let i = 0; i < 30 && !(await ollamaUp()); i++) await new Promise((r) => setTimeout(r, 1000));
}
