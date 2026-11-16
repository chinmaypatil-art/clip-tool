import { NextResponse } from "next/server";
import { ACCESS_COOKIE, accessToken, appPassword } from "@/lib/access";

export async function POST(request: Request) {
  const password = appPassword();
  const form = await request.formData();
  if (!password || form.get("password") !== password) {
    return NextResponse.redirect(new URL("/login?wrong=1", request.url), 303);
  }
  const res = NextResponse.redirect(new URL("/", request.url), 303);
  res.cookies.set(ACCESS_COOKIE, await accessToken(password), {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(request.url).protocol === "https:",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
