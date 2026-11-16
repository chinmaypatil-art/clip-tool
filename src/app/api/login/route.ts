import { NextResponse } from "next/server";
import { ACCESS_COOKIE, accessToken, appPassword } from "@/lib/access";

// Relative redirects: behind Tailscale Funnel request.url is localhost:3000,
// which a visitor's browser can't reach.
const redirectTo = (location: string) => new NextResponse(null, { status: 303, headers: { Location: location } });

export async function POST(request: Request) {
  const password = appPassword();
  const form = await request.formData();
  if (!password || form.get("password") !== password) return redirectTo("/login?wrong=1");
  const res = redirectTo("/");
  res.cookies.set(ACCESS_COOKIE, await accessToken(password), {
    httpOnly: true,
    sameSite: "lax",
    // Funnel visitors use https even though the request reaches us over http.
    secure: request.headers.get("x-forwarded-proto") === "https",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
