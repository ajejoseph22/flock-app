import { pollLoginChallenge } from "@flock/core";
import { cookies } from "next/headers";
import { deps } from "@/lib/server/deps";
import { clientIp, isSameOrigin, json } from "@/lib/server/http";
import { allow } from "@/lib/server/rate-limit";
import { cookieBase, LOGIN_COOKIE, SESSION_COOKIE } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Polled by /login. Mints the session cookie once the Telegram user has confirmed in the bot. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json({ error: "forbidden" }, 403);
  const jar = await cookies();
  const challengeCookie = jar.get(LOGIN_COOKIE)?.value;
  const key = challengeCookie?.split(".")[0] ?? clientIp(req) ?? "unknown";
  if (!(await allow(`auth:poll:${key}`, 200, 10 * 60_000))) return json({ state: "rate_limited" }, 429);

  const result = await pollLoginChallenge(deps(), challengeCookie, { ip: clientIp(req), userAgent: req.headers.get("user-agent") });
  if (result.state !== "signed_in") {
    if (result.state === "expired" || result.state === "rejected" || result.state === "invalid") jar.delete(LOGIN_COOKIE);
    return json({ state: result.state });
  }
  jar.delete(LOGIN_COOKIE);
  jar.set(SESSION_COOKIE, result.sessionToken, { ...cookieBase(), expires: result.sessionExpiresAt });
  return json({ state: "signed_in", redirectTo: result.returnTo ?? "/account" });
}
