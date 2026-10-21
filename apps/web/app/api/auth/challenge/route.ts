import { createLoginChallenge, LOGIN_CHALLENGE_TTL_MS, safeReturnTo } from "@flock/core";
import QRCode from "qrcode";
import { cookies } from "next/headers";
import { deps } from "@/lib/server/deps";
import { clientIp, isSameOrigin, json } from "@/lib/server/http";
import { allow } from "@/lib/server/rate-limit";
import { cookieBase, LOGIN_COOKIE } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Start a Telegram sign-in: returns the bot deep link; the browser keeps a secret in an HTTP-only cookie. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json({ error: "forbidden" }, 403);
  const ip = clientIp(req) ?? "unknown";
  if (!(await allow(`auth:challenge:${ip}`, 20, 10 * 60_000))) return json({ error: "Too many sign-in attempts. Please wait a few minutes." }, 429);

  const body = (await req.json().catch(() => ({}))) as { returnTo?: unknown };
  const d = deps();
  const challenge = await createLoginChallenge(d, {
    returnTo: safeReturnTo(typeof body.returnTo === "string" ? body.returnTo : null),
    ip,
    userAgent: req.headers.get("user-agent"),
  });
  (await cookies()).set(LOGIN_COOKIE, challenge.browserCookie, { ...cookieBase(), maxAge: Math.floor(LOGIN_CHALLENGE_TTL_MS / 1000) });
  const qrSvg = await QRCode.toString(challenge.deepLink, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return json({ deepLink: challenge.deepLink, appLink: challenge.appLink, expiresAt: challenge.expiresAt.toISOString(), qrSvg });
}
