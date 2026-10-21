import { createFreshOnboardingLink } from "@flock/core";
import { NextResponse } from "next/server";
import { deps } from "@/lib/server/deps";
import { userMessage } from "@/lib/server/http";
import { creatorForAction, loginUrl } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stripe's refresh_url: the onboarding link expired or was reused. Issue a new one for the signed-in creator only. */
export async function GET() {
  const d = deps();
  const base = d.config.appUrl;
  const ctx = await creatorForAction();
  if (!ctx) return NextResponse.redirect(new URL(loginUrl("/dashboard/setup"), base));
  try {
    const url = await createFreshOnboardingLink(d, ctx.creator.id);
    return NextResponse.redirect(url);
  } catch (err) {
    const msg = userMessage(err, "stripe.refresh");
    return NextResponse.redirect(new URL(`/dashboard/setup?error=${encodeURIComponent(msg)}`, base));
  }
}
