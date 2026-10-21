import { getCheckoutStatus, requestCheckoutVerification } from "@flock/core";
import { deps } from "@/lib/server/deps";
import { json } from "@/lib/server/http";
import { currentUser } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Post-checkout status, read from our database only. While still "confirming" we ask the
 * worker to check the Checkout Session with Stripe directly (deduped), in case the webhook is slow.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const intentId = new URL(req.url).searchParams.get("intent") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(intentId)) return json({ error: "not found" }, 404);
  const d = deps();
  const status = await getCheckoutStatus(d, user.id, intentId);
  if (!status) return json({ error: "not found" }, 404);
  if (status.view.state === "confirming") await requestCheckoutVerification(d.db, intentId);
  return json({ view: status.view });
}
