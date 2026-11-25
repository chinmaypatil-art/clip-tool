// Runs before `next start`: `npm run build` writes to .next-new so the running
// server's .next stays intact (overwriting it under a live server made pages
// ask for files that no longer existed). Here, with no server running, the
// finished build takes .next's place.
import { existsSync, renameSync, rmSync } from "node:fs";

// Windows briefly locks folders (antivirus, indexer, the old process exiting),
// so a rename can fail with EPERM for a few seconds: wait and try again.
function rename(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return renameSync(from, to);
    } catch (err) {
      if (attempt >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
}

if (existsSync(".next-new/BUILD_ID")) {
  rmSync(".next-old", { recursive: true, force: true });
  if (existsSync(".next")) rename(".next", ".next-old");
  try {
    rename(".next-new", ".next");
  } catch (err) {
    // Never start without a build: put the old one back and try the new one next restart.
    if (existsSync(".next-old")) rename(".next-old", ".next");
    console.error("[update] couldn't switch to the new build, keeping the old one:", err.message);
  }
  rmSync(".next-old", { recursive: true, force: true });
  if (existsSync(".next/BUILD_ID") && !existsSync(".next-new")) console.log("[update] switched to the new build");
}
