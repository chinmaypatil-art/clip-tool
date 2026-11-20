// Updates yt-dlp in place (run at startup by start-shared.cmd): YouTube
// changes often, and a stale yt-dlp is the usual reason downloads break.
import { spawnSync } from "node:child_process";
import { getYtDlpPath } from "../src/lib/binaries";

spawnSync(getYtDlpPath(), ["-U"], { stdio: "inherit", timeout: 120_000 });
