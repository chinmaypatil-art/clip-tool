import { execFile } from "child_process";
import path from "path";
import { createLimiter } from "./limit";
import { processSingleton } from "./processState";
import { getAnalysis } from "./analyses";

/**
 * Videos Gemma can't pick (almost no speech, or the user chose Claude) are
 * picked by Claude Code running headless on this machine with the Clipwise
 * MCP: it watches the video (get_loud_moments, get_timeline) and sends its
 * picks with submit_clips. Uses this machine's Claude Code login, not an API
 * key. CLAUDE_AUTO_PICK=0 turns it off; the video then waits for someone to
 * ask Claude in a chat.
 */

const PICK_TIMEOUT_MS = 45 * 60_000;
// One at a time: each run reads many frame sheets.
const claudeSlot = processSingleton("claudeSlot", () => createLimiter(1));

function prompt(analysisId: string): string {
  const a = getAnalysis(analysisId);
  const count = a?.clipCount ?? 5;
  return [
    `Use the clipwise MCP to pick clips for analysisId ${analysisId}.`,
    `Follow the HOW TO PICK guide in the clipwise server instructions exactly.`,
    `Pick up to ${count} clips with get_loud_moments and get_timeline, then call submit_clips once with picker "claude-auto".`,
    a?.clipLength ? `Use the video's chosen clip length (${a.clipLength}).` : "",
    a?.focus ? `The user asked for: ${a.focus}.` : "",
    `Do not do anything else. Reply DONE when submitted.`,
  ].filter(Boolean).join(" ");
}

export function autoPickWithClaude(analysisId: string): void {
  if (process.env.CLAUDE_AUTO_PICK === "0") return;
  void claudeSlot(
    () =>
      new Promise<void>((resolve) => {
        const cwd = process.cwd();
        execFile(
          "claude",
          [
            "-p", prompt(analysisId),
            "--mcp-config", path.join(cwd, ".mcp.json"),
            "--strict-mcp-config",
            "--allowedTools", "mcp__clipwise__get_loud_moments mcp__clipwise__get_timeline mcp__clipwise__get_progress mcp__clipwise__submit_clips",
            "--output-format", "text",
          ],
          { cwd, timeout: PICK_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout) => {
            if (err) console.error(`[claudePicker] ${analysisId} failed:`, err.message);
            else console.log(`[claudePicker] ${analysisId}: ${stdout.trim().slice(-200)}`);
            resolve();
          }
        );
      })
  );
}
