import "server-only";
import { handleStripeWebhook, type StripeWebhookKind } from "@flock/payments";
import { json } from "./http";
import { web } from "./deps";

/** Shared POST handler for the three Stripe webhook destinations. Reads the raw body for signature checks. */
export function stripeWebhookRoute(kind: StripeWebhookKind) {
  return async function POST(req: Request) {
    const { deps, stripe } = web();
    const rawBody = await req.text();
    const result = await handleStripeWebhook(kind, {
      stripe,
      db: deps.db,
      config: deps.config,
      log: deps.log,
      rawBody,
      signature: req.headers.get("stripe-signature"),
    });
    return json(result.body, result.status);
  };
}
