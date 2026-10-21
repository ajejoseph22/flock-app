import { getMerchantForCreator, refreshMerchant } from "@flock/core";
import { NextResponse } from "next/server";
import { deps } from "@/lib/server/deps";
import { creatorForAction, loginUrl } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe sends the creator back here after onboarding. The return itself proves nothing:
 * we re-read the account from Stripe and show whatever Stripe reports.
 */
export async function GET() {
  const d = deps();
  const base = d.config.appUrl;
  const ctx = await creatorForAction();
  if (!ctx) return NextResponse.redirect(new URL(loginUrl("/dashboard/setup"), base));
  const merchant = await getMerchantForCreator(d.db, ctx.creator.id);
  if (merchant) {
    try {
      await refreshMerchant(d, merchant.stripeAccountId);
    } catch (err) {
      d.log.warn({ err: err instanceof Error ? err.message : String(err) }, "merchant refresh on return failed; webhook/reconciliation will catch up");
    }
  }
  return NextResponse.redirect(new URL("/dashboard/setup?stripe=returned", base));
}
