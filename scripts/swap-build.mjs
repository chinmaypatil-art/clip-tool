// Runs before `next start`: `npm run build` writes to .next-new so the running
// server's .next stays intact (overwriting it under a live server made pages
// ask for files that no longer existed). Here, with no server running, the
// finished build takes .next's place.
import { existsSync, renameSync, rmSync } from "node:fs";

if (existsSync(".next-new/BUILD_ID")) {
  rmSync(".next-old", { recursive: true, force: true });
  if (existsSync(".next")) renameSync(".next", ".next-old");
  renameSync(".next-new", ".next");
  rmSync(".next-old", { recursive: true, force: true });
  console.log("[update] switched to the new build");
}
