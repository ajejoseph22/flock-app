import { revokeSession, safeReturnTo } from "@flock/core";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { deps } from "@/lib/server/deps";
import { isSameOrigin } from "@/lib/server/http";
import { SESSION_COOKIE } from "@/lib/server/session";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return new NextResponse("Forbidden", { status: 403 });
  const jar = await cookies();
  await revokeSession(deps().db, jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  const form = await req.formData().catch(() => null);
  const returnTo = safeReturnTo(typeof form?.get("returnTo") === "string" ? (form.get("returnTo") as string) : null);
  return NextResponse.redirect(new URL(returnTo ?? "/", deps().config.appUrl), 303);
}
