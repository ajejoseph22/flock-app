import { communities, entitlements, merchantAccounts, subscriberCustomers, subscriptions, telegramAccessGrants } from "@flock/db";
import { and, desc, eq } from "drizzle-orm";
import type { Deps } from "../deps";
import { NotFoundError } from "../errors";
import { ensurePortalConfiguration } from "./merchant";

/** A subscriber's memberships across all creators, for /account. */
export async function listMemberships(deps: Pick<Deps, "db" | "now">, userId: string) {
  const rows = await deps.db
    .select({ subscription: subscriptions, entitlement: entitlements, community: communities, grant: telegramAccessGrants })
    .from(subscriptions)
    .innerJoin(communities, eq(communities.id, subscriptions.communityId))
    .leftJoin(entitlements, eq(entitlements.subscriptionId, subscriptions.id))
    .leftJoin(
      telegramAccessGrants,
      and(eq(telegramAccessGrants.userId, subscriptions.userId), eq(telegramAccessGrants.communityId, subscriptions.communityId)),
    )
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.createdAt));
  const now = deps.now();
  return rows.map((r) => {
    const active = r.entitlement?.status === "active" && r.entitlement.accessEndsAt !== null && r.entitlement.accessEndsAt > now;
    return {
      subscriptionId: r.subscription.id,
      communityName: r.community.name,
      communitySlug: r.community.slug,
      status: r.subscription.status,
      active,
      reason: r.entitlement?.reason ?? null,
      cancelAtPeriodEnd: r.subscription.cancelAtPeriodEnd,
      renewsAt: active && !r.subscription.cancelAtPeriodEnd && r.subscription.status === "active" ? r.subscription.currentPeriodEnd : null,
      accessEndsAt: r.entitlement?.accessEndsAt ?? null,
      paidThrough: r.subscription.paidThrough,
      amountMinor: r.subscription.amountMinor,
      currency: r.subscription.currency,
      grantState: r.grant?.state ?? null,
      inviteLink: active && r.grant?.state === "invited" ? r.grant.inviteLink : null,
    };
  });
}

/**
 * Billing Portal session on the creator's connected account, for the session user's own subscription only.
 */
export async function createSubscriberPortalSession(deps: Deps, userId: string, subscriptionId: string) {
  const [row] = await deps.db
    .select({ subscription: subscriptions, merchant: merchantAccounts, customer: subscriberCustomers, community: communities })
    .from(subscriptions)
    .innerJoin(merchantAccounts, eq(merchantAccounts.id, subscriptions.merchantAccountId))
    .innerJoin(subscriberCustomers, eq(subscriberCustomers.id, subscriptions.subscriberCustomerId))
    .innerJoin(communities, eq(communities.id, subscriptions.communityId))
    .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.userId, userId), eq(subscriberCustomers.userId, userId)))
    .limit(1);
  if (!row) throw new NotFoundError();
  const configurationId = await ensurePortalConfiguration(deps, row.merchant, `Manage your ${row.community.name} membership`);
  const session = await deps.stripe.createPortalSession(row.merchant.stripeAccountId, {
    customerId: row.customer.stripeCustomerId,
    returnUrl: `${deps.config.appUrl}/account`,
    configurationId,
  });
  return session.url;
}
