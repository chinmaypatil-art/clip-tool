import { readFileSync } from "fs";
import path from "path";
import { NextResponse } from "next/server";

// The build this server runs; read once, since a new build means a restart.
const buildId = (() => {
  try {
    return readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    return "dev";
  }
})();

/** Lets open pages notice the app was updated under them (UpdateWatcher). */
export function GET() {
  return NextResponse.json({ buildId }, { headers: { "Cache-Control": "no-store" } });
}
