import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hasAccess } from "@/lib/access";
import { noteRequest } from "@/lib/activity";

/** Sends visitors without the access cookie to /login (APIs get a 401). */
export async function proxy(request: NextRequest) {
  noteRequest();
  if (await hasAccess(request)) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Log in first" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

// /api/analyses checks access itself: requests passing through the proxy are
// buffered in memory and cut off at 10 MB, which would truncate video uploads.
export const config = {
  matcher: ["/((?!login|api/login|api/analyses$|_next/|favicon.ico).*)"],
};
