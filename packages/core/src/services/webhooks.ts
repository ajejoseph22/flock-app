import type { Update } from "@grammyjs/types";
import { checkoutIntents, merchantAccounts, webhookEvents, type Database } from "@flock/db";
import { and, eq, sql } from "drizzle-orm";
import { ANALYTICS } from "../analytics-events";
import type { Deps } from "../deps";
import { sha256 } from "../crypto";
import { enqueue } from "../jobs/queue";
import { track } from "./audit";
import { syncConnectedSubscription, type SubscriptionAdjustment } from "./billing-sync";
import { refreshMerchant } from "./merchant";
import { syncPlatformSubscription } from "./platform-billing";
import { processTelegramUpdate } from "./telegram-updates";

type Provider = (typeof webhookEvents.$inferInsert)["provider"];

export interface IngestInput {
  provider: Provider;
  externalId: string;
  type: string;
  stripeAccountId?: string | null;
  payload: unknown;
}

/**
 * Persist a verified provider event and enqueue its processing atomically.
 * Duplicate deliveries (same provider + event ID) are acknowledged without reprocessing.
 */
export async function ingestWebhookEvent(db: Database, input: IngestInput): Promise<{ duplicate: boolean; eventId: string | null }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(webhookEvents)
      .values({
        provider: input.provider,
        externalId: input.externalId,
        type: input.type,
        stripeAccountId: input.stripeAccountId ?? null,
        payload: input.payload,
      })
      .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.externalId] })
      .returning({ id: webhookEvents.id });
    if (!row) return { duplicate: true, eventId: null };
    await enqueue(tx, "webhook.process", { webhookEventId: row.id }, { maxAttempts: 12 });
    return { duplicate: false, eventId: row.id };
  });
}

/** Worker entry point for `webhook.process`. Throws to trigger a retry. */
export async function processWebhookEvent(deps: Deps, webhookEventId: string): Promise<void> {
  const [event] = await deps.db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookEventId)).limit(1);
  if (!event || event.status === "processed" || event.status === "ignored") return;
  await deps.db.update(webhookEvents).set({ attempts: sql`${webhookEvents.attempts} + 1` }).where(eq(webhookEvents.id, event.id));
  try {
    let outcome: "processed" | "ignored";
    switch (event.provider) {
      case "telegram":
        outcome = await processTelegramUpdate(deps, event.payload as Update);
        break;
      case "stripe_connect":
        outcome = await processConnectEvent(deps, event.payload as StripeEventLike);
        break;
      case "stripe_platform":
        outcome = await processPlatformEvent(deps, event.payload as StripeEventLike);
        break;
      case "stripe_accounts":
        outcome = await processAccountsThinEvent(deps, event.payload as ThinEventLike);
        break;
    }
    await deps.db.update(webhookEvents).set({ status: outcome, processedAt: deps.now(), lastError: null }).where(eq(webhookEvents.id, event.id));
    const latencyMs = deps.now().getTime() - event.receivedAt.getTime();
    deps.log.info({ provider: event.provider, type: event.type, outcome, latencyMs }, "webhook processed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.db.update(webhookEvents).set({ status: "failed", lastError: message.slice(0, 1000) }).where(eq(webhookEvents.id, event.id));
    throw err;
  }
}

// ─── Stripe connected-account events ────────────────────────────────────────

export interface StripeEventLike {
  id: string;
  type: string;
  account?: string | null;
  livemode?: boolean;
  data: { object: Record<string, unknown> };
}

export interface ThinEventLike {
  id: string;
  type: string;
  related_object?: { id: string; type: string } | null;
}

const idOf = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" && "id" in v && typeof v.id === "string" ? v.id : null);

function invoiceSubscriptionId(invoice: Record<string, unknown>): string | null {
  const parent = invoice.parent as { subscription_details?: { subscription?: unknown } | null } | null | undefined;
  return idOf(parent?.subscription_details?.subscription) ?? idOf(invoice.subscription);
}

/** charge → payment intent → invoice payment → invoice → subscription (basil+ API shape). */
async function subscriptionForCharge(deps: Deps, accountId: string, chargeId: string) {
  const charge = await deps.stripe.retrieveChargePaymentIntent(accountId, chargeId);
  if (!charge.paymentIntentId) return null;
  const invoiceId = await deps.stripe.findInvoiceIdForPaymentIntent(accountId, charge.paymentIntentId);
  if (!invoiceId) return null;
  const invoice = await deps.stripe.retrieveInvoice(accountId, invoiceId);
  return invoice.subscriptionId ? { subscriptionId: invoice.subscriptionId, invoiceId, charge } : null;
}

export async function processConnectEvent(deps: Deps, event: StripeEventLike): Promise<"processed" | "ignored"> {
  const accountId = event.account;
  if (!accountId) return "ignored";
  const [merchant] = await deps.db.select().from(merchantAccounts).where(eq(merchantAccounts.stripeAccountId, accountId)).limit(1);
  if (!merchant) {
    deps.log.warn({ eventId: event.id, accountId }, "connect event for unknown account");
    return "ignored";
  }
  const obj = event.data.object;
  const sync = async (subscriptionId: string | null, adjustment?: SubscriptionAdjustment) => {
    if (!subscriptionId) return "ignored" as const;
    const r = await syncConnectedSubscription(deps, accountId, subscriptionId, adjustment);
    return r.outcome === "synced" ? ("processed" as const) : ("ignored" as const);
  };

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed": {
      if (obj.mode !== "subscription") return "ignored";
      const intentId = typeof obj.client_reference_id === "string" ? obj.client_reference_id : null;
      const subscriptionId = idOf(obj.subscription);
      if (intentId && /^[0-9a-f-]{36}$/.test(intentId)) {
        const [intent] = await deps.db
          .update(checkoutIntents)
          .set({ stripeSubscriptionId: subscriptionId, ...(event.type === "checkout.session.async_payment_failed" ? { status: "failed" as const } : {}) })
          .where(and(eq(checkoutIntents.id, intentId), eq(checkoutIntents.merchantAccountId, merchant.id)))
          .returning();
        if (intent && event.type === "checkout.session.completed") {
          await track(deps.db, ANALYTICS.checkoutCompleted, { userId: intent.userId, creatorId: intent.creatorId, communityId: intent.communityId });
        }
      }
      return sync(subscriptionId);
    }
    case "checkout.session.expired": {
      const intentId = typeof obj.client_reference_id === "string" ? obj.client_reference_id : null;
      if (intentId && /^[0-9a-f-]{36}$/.test(intentId)) {
        await deps.db
          .update(checkoutIntents)
          .set({ status: "expired" })
          .where(and(eq(checkoutIntents.id, intentId), eq(checkoutIntents.merchantAccountId, merchant.id), eq(checkoutIntents.status, "open")));
      }
      return "processed";
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
    case "customer.subscription.pending_update_applied":
    case "customer.subscription.pending_update_expired":
      return sync(idOf(obj.id));
    case "invoice.paid":
    case "invoice.payment_succeeded":
    case "invoice.payment_failed":
    case "invoice.payment_action_required":
    case "invoice.marked_uncollectible":
    case "invoice.voided":
      return sync(invoiceSubscriptionId(obj));
    case "charge.refunded": {
      const found = await subscriptionForCharge(deps, accountId, String(obj.id));
      if (!found) return "ignored";
      const full = found.charge.amountRefunded >= found.charge.amount;
      return sync(found.subscriptionId, full ? { excludeInvoiceId: found.invoiceId } : undefined);
    }
    case "charge.dispute.created":
    case "charge.dispute.funds_withdrawn": {
      const found = await subscriptionForCharge(deps, accountId, String(idOf(obj.charge)));
      if (!found) return "ignored";
      return sync(found.subscriptionId, { addDisputeId: String(obj.id) });
    }
    case "charge.dispute.closed": {
      const found = await subscriptionForCharge(deps, accountId, String(idOf(obj.charge)));
      if (!found) return "ignored";
      const won = obj.status === "won" || obj.status === "warning_closed";
      return sync(found.subscriptionId, won ? { removeDisputeId: String(obj.id) } : { removeDisputeId: String(obj.id), excludeInvoiceId: found.invoiceId });
    }
    case "account.updated":
      await refreshMerchant(deps, accountId);
      return "processed";
    default:
      return "ignored";
  }
}

export async function processAccountsThinEvent(deps: Deps, event: ThinEventLike): Promise<"processed" | "ignored"> {
  if (!event.type.startsWith("v2.core.account")) return "ignored";
  const accountId = event.related_object?.type === "v2.core.account" ? event.related_object.id : null;
  if (!accountId) return "ignored";
  const updated = await refreshMerchant(deps, accountId);
  return updated ? "processed" : "ignored";
}

export async function processPlatformEvent(deps: Deps, event: StripeEventLike): Promise<"processed" | "ignored"> {
  if (event.account) return "ignored"; // platform destination must only carry platform events
  const obj = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
      if (obj.mode !== "subscription") return "ignored";
      return (await syncPlatformSubscription(deps, idOf(obj.subscription))) ? "processed" : "ignored";
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return (await syncPlatformSubscription(deps, idOf(obj.id))) ? "processed" : "ignored";
    case "invoice.paid":
    case "invoice.payment_failed":
      return (await syncPlatformSubscription(deps, invoiceSubscriptionId(obj))) ? "processed" : "ignored";
    default:
      return "ignored";
  }
}

/** Requeue processing for events that never got processed (e.g. job went dead and was fixed). */
export async function requeueStuckWebhookEvents(db: Database, olderThan: Date) {
  const rows = await db.execute<{ id: string }>(sql`
    select id from ${webhookEvents}
    where status in ('pending', 'failed') and received_at < ${olderThan.toISOString()}::timestamptz
      and not exists (select 1 from jobs j where j.type = 'webhook.process' and j.status in ('queued', 'running') and j.payload->>'webhookEventId' = ${webhookEvents.id}::text)
      and attempts < 50
    limit 100
  `);
  for (const r of rows.rows) {
    await enqueue(db, "webhook.process", { webhookEventId: r.id }, { dedupeKey: `webhook:${r.id}`, maxAttempts: 3 });
  }
  return rows.rows.length;
}


/** Stable dedupe ID for a Telegram update: update_id plus a payload digest (update_ids can be reused after a week of inactivity). */
export function telegramUpdateExternalId(update: { update_id: number }): string {
  return `${update.update_id}:${sha256(JSON.stringify(update)).slice(0, 16)}`;
}

export function telegramUpdateType(update: Record<string, unknown>): string {
  return Object.keys(update).find((k) => k !== "update_id") ?? "unknown";
}
