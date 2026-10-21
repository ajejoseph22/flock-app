import {
  checkoutIntents,
  communities,
  entitlements,
  invoices as invoicesTable,
  merchantAccounts,
  planPrices,
  subscriberCustomers,
  subscriptions,
  type DbOrTx,
} from "@flock/db";
import { and, eq, sql } from "drizzle-orm";
import { ANALYTICS } from "../analytics-events";
import type { Deps } from "../deps";
import { computePaidThrough, evaluateEntitlement } from "../domain/eligibility";
import type { InvoiceSnapshot, SubscriptionSnapshot } from "../gateways";
import { enqueue } from "../jobs/queue";
import { audit, track } from "./audit";

export interface SubscriptionAdjustment {
  /** Full refund (or lost dispute): this invoice's period no longer counts toward paid-through. */
  excludeInvoiceId?: string;
  addDisputeId?: string;
  removeDisputeId?: string;
}

export type SyncResult =
  | { outcome: "synced"; subscriptionId: string; eligible: boolean; changed: boolean }
  | { outcome: "ignored"; reason: string };

async function lockSubscription(tx: DbOrTx, merchantAccountId: string, stripeSubscriptionId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`sub:${merchantAccountId}:${stripeSubscriptionId}`}, 0))`);
}

/**
 * Re-read a connected-account subscription from Stripe and converge local state (decision D-005).
 * Safe to call any number of times, in any order relative to other events.
 */
export async function syncConnectedSubscription(
  deps: Deps,
  stripeAccountId: string,
  stripeSubscriptionId: string,
  adjustment: SubscriptionAdjustment = {},
): Promise<SyncResult> {
  const [merchant] = await deps.db.select().from(merchantAccounts).where(eq(merchantAccounts.stripeAccountId, stripeAccountId)).limit(1);
  if (!merchant) return { outcome: "ignored", reason: "unknown_account" };

  const remote = await deps.stripe.retrieveSubscription(stripeAccountId, stripeSubscriptionId);
  const invoices = await deps.stripe.listSubscriptionInvoices(stripeAccountId, stripeSubscriptionId);

  return deps.db.transaction(async (tx) => {
    await lockSubscription(tx, merchant.id, stripeSubscriptionId);

    const [existing] = await tx
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.merchantAccountId, merchant.id), eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId)))
      .limit(1);

    let context: { userId: string; communityId: string; planId: string; subscriberCustomerId: string; checkoutIntentId: string | null; creatorId: string };
    if (existing) {
      const [community] = await tx.select({ creatorId: communities.creatorId }).from(communities).where(eq(communities.id, existing.communityId));
      context = {
        userId: existing.userId,
        communityId: existing.communityId,
        planId: existing.planId,
        subscriberCustomerId: existing.subscriberCustomerId,
        checkoutIntentId: existing.checkoutIntentId,
        creatorId: community!.creatorId,
      };
    } else {
      const resolved = await resolveContextFromIntent(tx, merchant.id, remote);
      if (!resolved.ok) return { outcome: "ignored", reason: resolved.reason } as const;
      context = resolved.context;
    }

    const [customer] = await tx.select().from(subscriberCustomers).where(eq(subscriberCustomers.id, context.subscriberCustomerId));
    if (!customer || customer.stripeCustomerId !== remote.customerId) {
      deps.log.warn({ stripeSubscriptionId, stripeAccountId }, "subscription customer mismatch; ignoring");
      return { outcome: "ignored", reason: "customer_mismatch" } as const;
    }

    const excluded = new Set(existing?.excludedInvoiceIds ?? []);
    if (adjustment.excludeInvoiceId) excluded.add(adjustment.excludeInvoiceId);
    const disputes = new Set(existing?.openDisputeIds ?? []);
    if (adjustment.addDisputeId) disputes.add(adjustment.addDisputeId);
    if (adjustment.removeDisputeId) disputes.delete(adjustment.removeDisputeId);

    const excludedIds = [...excluded];
    const paidThrough = computePaidThrough(invoices, excludedIds);
    const latestPaid = latestPaidInvoice(invoices);
    const latestInvoiceRefunded = latestPaid !== null && excluded.has(latestPaid.id);
    const [price] = remote.priceId ? await tx.select({ id: planPrices.id }).from(planPrices).where(eq(planPrices.stripePriceId, remote.priceId)) : [];

    const values = {
      status: remote.status,
      cancelAtPeriodEnd: remote.cancelAtPeriodEnd,
      cancelAt: remote.cancelAt,
      canceledAt: remote.canceledAt,
      endedAt: remote.endedAt,
      currentPeriodStart: remote.currentPeriodStart,
      currentPeriodEnd: remote.currentPeriodEnd,
      paidThrough,
      excludedInvoiceIds: excludedIds,
      openDisputeIds: [...disputes],
      latestInvoiceRefunded,
      amountMinor: remote.amountMinor,
      currency: remote.currency,
      planPriceId: price?.id ?? existing?.planPriceId ?? null,
      lastSyncedAt: deps.now(),
    };

    let subscriptionRowId: string;
    if (existing) {
      await tx.update(subscriptions).set(values).where(eq(subscriptions.id, existing.id));
      subscriptionRowId = existing.id;
    } else {
      const [inserted] = await tx
        .insert(subscriptions)
        .values({
          ...values,
          merchantAccountId: merchant.id,
          stripeSubscriptionId,
          userId: context.userId,
          communityId: context.communityId,
          planId: context.planId,
          subscriberCustomerId: context.subscriberCustomerId,
          checkoutIntentId: context.checkoutIntentId,
          stripeCreatedAt: remote.created,
        })
        .returning({ id: subscriptions.id });
      subscriptionRowId = inserted!.id;
      if (context.checkoutIntentId) {
        await tx
          .update(checkoutIntents)
          .set({ stripeSubscriptionId, status: "completed", completedAt: deps.now() })
          .where(and(eq(checkoutIntents.id, context.checkoutIntentId), sql`${checkoutIntents.status} <> 'completed'`));
      }
    }

    for (const inv of invoices) {
      if (inv.status !== "paid" && inv.status !== "open" && inv.status !== "uncollectible") continue;
      const row = {
        status: inv.status,
        amountPaidMinor: inv.amountPaid,
        currency: inv.currency,
        periodEnd: inv.periodEnd,
        paidAt: inv.paidAt,
        refunded: excluded.has(inv.id),
      };
      await tx
        .insert(invoicesTable)
        .values({ ...row, subscriptionId: subscriptionRowId, merchantAccountId: merchant.id, communityId: context.communityId, userId: context.userId, stripeInvoiceId: inv.id })
        .onConflictDoUpdate({ target: [invoicesTable.merchantAccountId, invoicesTable.stripeInvoiceId], set: row });
    }

    const result = await applyEntitlement(tx, deps, {
      subscriptionRowId,
      ...context,
      status: remote.status,
      paidThrough,
      disputed: disputes.size > 0,
      latestInvoiceRefunded,
      cancelAtPeriodEnd: remote.cancelAtPeriodEnd,
      previousStatus: existing?.status ?? null,
    });
    return { outcome: "synced", subscriptionId: subscriptionRowId, eligible: result.eligible, changed: result.changed } as const;
  });
}

function latestPaidInvoice(invoices: InvoiceSnapshot[]): InvoiceSnapshot | null {
  let best: InvoiceSnapshot | null = null;
  for (const inv of invoices) {
    if (inv.status !== "paid" || !inv.periodEnd) continue;
    if (!best || inv.periodEnd > best.periodEnd!) best = inv;
  }
  return best;
}

async function resolveContextFromIntent(tx: DbOrTx, merchantAccountId: string, remote: SubscriptionSnapshot) {
  const intentId = remote.metadata.flock_checkout_intent_id;
  if (!intentId || !/^[0-9a-f-]{36}$/.test(intentId)) return { ok: false, reason: "not_created_by_flock" } as const;
  const [intent] = await tx
    .select()
    .from(checkoutIntents)
    .where(and(eq(checkoutIntents.id, intentId), eq(checkoutIntents.merchantAccountId, merchantAccountId)))
    .limit(1);
  if (!intent) return { ok: false, reason: "intent_not_found_for_account" } as const;
  if (remote.metadata.flock_user_id && remote.metadata.flock_user_id !== intent.userId) return { ok: false, reason: "metadata_user_mismatch" } as const;
  const context = {
    userId: intent.userId,
    communityId: intent.communityId,
    planId: intent.planId,
    subscriberCustomerId: intent.subscriberCustomerId,
    checkoutIntentId: intent.id as string | null,
    creatorId: intent.creatorId,
  };
  return { ok: true, context } as const;
}

interface EntitlementInput {
  subscriptionRowId: string;
  userId: string;
  communityId: string;
  creatorId: string;
  status: string;
  paidThrough: Date | null;
  disputed: boolean;
  latestInvoiceRefunded: boolean;
  cancelAtPeriodEnd: boolean;
  previousStatus: string | null;
}

/** Evaluate and persist the entitlement for a subscription; enqueue access reconciliation on change. */
async function applyEntitlement(tx: DbOrTx, deps: Pick<Deps, "now" | "config">, input: EntitlementInput) {
  const now = deps.now();
  const evaluation = evaluateEntitlement({
    status: input.status,
    paidThrough: input.paidThrough,
    disputed: input.disputed,
    latestInvoiceRefunded: input.latestInvoiceRefunded,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    now,
    graceMs: deps.config.access.renewalGraceMs,
  });
  const [current] = await tx.select().from(entitlements).where(eq(entitlements.subscriptionId, input.subscriptionRowId)).limit(1);
  const status = evaluation.eligible ? ("active" as const) : ("ended" as const);

  // A subscription that was never eligible doesn't need an entitlement row yet.
  if (!current && !evaluation.eligible) return { eligible: false, changed: false };

  const changed =
    !current ||
    current.status !== status ||
    current.reason !== evaluation.reason ||
    (current.accessEndsAt?.getTime() ?? null) !== (evaluation.accessEndsAt?.getTime() ?? null);

  if (!changed) return { eligible: evaluation.eligible, changed: false };

  if (!current) {
    await tx.insert(entitlements).values({
      subscriptionId: input.subscriptionRowId,
      userId: input.userId,
      communityId: input.communityId,
      status,
      reason: evaluation.reason,
      accessEndsAt: evaluation.accessEndsAt,
      activatedAt: now,
    });
  } else {
    await tx
      .update(entitlements)
      .set({
        status,
        reason: evaluation.reason,
        accessEndsAt: evaluation.accessEndsAt,
        activatedAt: status === "active" && current.status !== "active" ? now : current.activatedAt,
        endedAt: status === "ended" && current.status !== "ended" ? now : status === "active" ? null : current.endedAt,
      })
      .where(eq(entitlements.id, current.id));
  }

  const ids = { userId: input.userId, creatorId: input.creatorId, communityId: input.communityId };
  if (current?.status !== status) {
    await audit(tx, {
      actorType: "stripe",
      creatorId: input.creatorId,
      communityId: input.communityId,
      subjectUserId: input.userId,
      action: status === "active" ? "entitlement.activated" : "entitlement.ended",
      details: { reason: evaluation.reason, accessEndsAt: evaluation.accessEndsAt?.toISOString() ?? null, subscriptionStatus: input.status },
    });
    if (status === "active") await track(tx, ANALYTICS.subscriptionActivated, ids, { reason: evaluation.reason });
  } else {
    await audit(tx, {
      actorType: "stripe",
      creatorId: input.creatorId,
      communityId: input.communityId,
      subjectUserId: input.userId,
      action: "entitlement.updated",
      details: { reason: evaluation.reason, accessEndsAt: evaluation.accessEndsAt?.toISOString() ?? null, subscriptionStatus: input.status },
    });
  }
  if (input.previousStatus !== null && input.previousStatus !== "canceled" && input.status === "canceled") {
    await track(tx, ANALYTICS.subscriptionCanceled, ids);
  } else if (input.cancelAtPeriodEnd && current?.reason !== "canceled_until_period_end" && evaluation.reason === "canceled_until_period_end") {
    await track(tx, ANALYTICS.subscriptionCanceled, ids, { atPeriodEnd: true });
  }

  await enqueue(tx, "access.reconcile", { userId: input.userId, communityId: input.communityId }, { dedupeKey: `reconcile:${input.userId}:${input.communityId}` });
  return { eligible: evaluation.eligible, changed: true };
}

/**
 * Re-evaluate an entitlement from local subscription data only (no Stripe call).
 * Used by the expiry sweep when `access_ends_at` passes.
 */
export async function recomputeEntitlementLocally(deps: Pick<Deps, "db" | "now" | "config">, subscriptionRowId: string) {
  return deps.db.transaction(async (tx) => {
    const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, subscriptionRowId)).limit(1);
    if (!sub) return null;
    await lockSubscription(tx, sub.merchantAccountId, sub.stripeSubscriptionId);
    const [community] = await tx.select({ creatorId: communities.creatorId }).from(communities).where(eq(communities.id, sub.communityId));
    return applyEntitlement(tx, deps, {
      subscriptionRowId: sub.id,
      userId: sub.userId,
      communityId: sub.communityId,
      creatorId: community!.creatorId,
      status: sub.status,
      paidThrough: sub.paidThrough,
      disputed: sub.openDisputeIds.length > 0,
      latestInvoiceRefunded: sub.latestInvoiceRefunded,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      previousStatus: sub.status,
    });
  });
}

/** Verify a Checkout Session directly with Stripe (used after the success redirect, never trusted on its own). */
export async function syncCheckoutIntent(deps: Deps, checkoutIntentId: string) {
  const [intent] = await deps.db.select().from(checkoutIntents).where(eq(checkoutIntents.id, checkoutIntentId)).limit(1);
  if (!intent?.stripeCheckoutSessionId) return { outcome: "ignored" as const, reason: "no_session" };
  const session = await deps.stripe.retrieveCheckoutSession(intent.stripeAccountId, intent.stripeCheckoutSessionId);
  if (session.clientReferenceId !== intent.id) return { outcome: "ignored" as const, reason: "reference_mismatch" };
  if (session.status === "expired") {
    await deps.db.update(checkoutIntents).set({ status: "expired" }).where(and(eq(checkoutIntents.id, intent.id), eq(checkoutIntents.status, "open")));
    return { outcome: "expired" as const };
  }
  if (session.status === "complete" && session.subscriptionId) {
    await deps.db.update(checkoutIntents).set({ stripeSubscriptionId: session.subscriptionId }).where(eq(checkoutIntents.id, intent.id));
    return syncConnectedSubscription(deps, intent.stripeAccountId, session.subscriptionId);
  }
  return { outcome: "ignored" as const, reason: `session_${session.status}` };
}
