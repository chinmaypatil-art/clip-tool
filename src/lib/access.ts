/**
 * Optional password gate for sharing the app over a public link. Set
 * APP_PASSWORD in .env.local to turn it on; without it the app is open, as
 * it is on localhost. The cookie holds a hash of the password, so changing
 * the password logs everyone out.
 */

export const ACCESS_COOKIE = "clipwise_access";

export function appPassword(): string | undefined {
  return process.env.APP_PASSWORD || undefined;
}

export async function accessToken(password: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`clipwise:${password}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
