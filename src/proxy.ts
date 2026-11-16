import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ACCESS_COOKIE, accessToken, appPassword } from "@/lib/access";

/** Sends visitors without the access cookie to /login (APIs get a 401). */
export async function proxy(request: NextRequest) {
  const password = appPassword();
  if (!password) return NextResponse.next();
  if (request.cookies.get(ACCESS_COOKIE)?.value === (await accessToken(password))) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Log in first" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!login|api/login|_next/|favicon.ico).*)"],
};
