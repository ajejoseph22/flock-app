import type Stripe from "stripe";

export const MAX_STRIPE_PAYLOAD_BYTES = 1_000_000;

export type VerifiedSnapshotEvent = { kind: "snapshot"; event: Stripe.Event };
export type VerifiedThinEvent = { kind: "thin"; id: string; type: string; relatedObject: { id: string; type: string } | null; raw: unknown };

/** Verify a v1 snapshot event (Connect or platform destination) against the raw body. Throws on failure. */
export function verifySnapshotEvent(stripe: Stripe, rawBody: string, signature: string | null, secret: string): Stripe.Event {
  if (!signature) throw new Error("missing Stripe-Signature header");
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/** Verify a v2 thin event notification (Accounts v2 status changes). Throws on failure. */
export function verifyThinEvent(stripe: Stripe, rawBody: string, signature: string | null, secret: string): VerifiedThinEvent {
  if (!signature) throw new Error("missing Stripe-Signature header");
  const n = stripe.parseEventNotification(rawBody, signature, secret);
  const related = (n as { related_object?: { id: string; type: string } | null }).related_object ?? null;
  return { kind: "thin", id: n.id, type: n.type, relatedObject: related ? { id: related.id, type: related.type } : null, raw: JSON.parse(rawBody) as unknown };
}
