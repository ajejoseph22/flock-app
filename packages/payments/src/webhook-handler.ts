import { ingestWebhookEvent, type AppConfig, type Logger } from "@flock/core";
import type { Database } from "@flock/db";
import type Stripe from "stripe";
import { MAX_STRIPE_PAYLOAD_BYTES, verifySnapshotEvent, verifyThinEvent } from "./webhooks";

export type StripeWebhookKind = "connect" | "platform" | "accounts";

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Verify → persist → enqueue. Returns 2xx only once the event is durably stored.
 * Framework-agnostic so it can be tested without Next.js.
 */
export async function handleStripeWebhook(
  kind: StripeWebhookKind,
  input: { stripe: Stripe; db: Database; config: AppConfig; log: Logger; rawBody: string; signature: string | null },
): Promise<WebhookResponse> {
  if (Buffer.byteLength(input.rawBody) > MAX_STRIPE_PAYLOAD_BYTES) return { status: 413, body: { error: "payload too large" } };
  const secret =
    kind === "connect" ? input.config.stripe.connectWebhookSecret : kind === "platform" ? input.config.stripe.platformWebhookSecret : input.config.stripe.accountsWebhookSecret;

  try {
    if (kind === "accounts") {
      const thin = verifyThinEvent(input.stripe, input.rawBody, input.signature, secret);
      const r = await ingestWebhookEvent(input.db, { provider: "stripe_accounts", externalId: thin.id, type: thin.type, stripeAccountId: thin.relatedObject?.id ?? null, payload: thin.raw });
      return { status: 200, body: { received: true, duplicate: r.duplicate } };
    }
    const event = verifySnapshotEvent(input.stripe, input.rawBody, input.signature, secret);
    if (kind === "connect" && !event.account) return { status: 400, body: { error: "connect events must carry an account" } };
    if (kind === "platform" && event.account) return { status: 400, body: { error: "platform endpoint received a connected-account event" } };
    if (event.livemode !== input.config.stripe.livemode) {
      input.log.warn({ eventId: event.id, livemode: event.livemode }, "stripe event mode mismatch; ignoring");
      return { status: 200, body: { received: true, ignored: "mode_mismatch" } };
    }
    const r = await ingestWebhookEvent(input.db, {
      provider: kind === "connect" ? "stripe_connect" : "stripe_platform",
      externalId: event.id,
      type: event.type,
      stripeAccountId: event.account ?? null,
      payload: event,
    });
    return { status: 200, body: { received: true, duplicate: r.duplicate } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/signature|header|timestamp/i.test(message) || (err as { type?: string }).type === "StripeSignatureVerificationError") {
      input.log.warn({ kind }, "stripe webhook signature verification failed");
      return { status: 400, body: { error: "invalid signature" } };
    }
    if (err instanceof SyntaxError) return { status: 400, body: { error: "invalid payload" } };
    input.log.error({ kind, err: message }, "stripe webhook ingest failed");
    return { status: 500, body: { error: "ingest failed" } };
  }
}
