import {
  checkoutIntents,
  communities,
  creators,
  entitlements,
  membershipPlans,
  merchantAccounts,
  planPrices,
  subscriberCustomers,
  subscriptions,
  telegramAccessGrants,
  telegramChats,
  type DbOrTx,
} from "@flock/db";
import { and, desc, eq, gt } from "drizzle-orm";
import { ANALYTICS } from "../analytics-events";
import type { Deps } from "../deps";
import { AppError, NotFoundError } from "../errors";
import { enqueue } from "../jobs/queue";
import { displayTelegramName } from "../telegram-html";
import { track } from "./audit";
import { isMerchantReady } from "./merchant";

/** Everything the public membership page renders. Returns null for unknown or unpublished slugs. */
export async function getPublicCommunity(db: DbOrTx, slug: string, opts: { previewCreatorId?: string | null } = {}) {
  const [row] = await db
    .select({ community: communities, creator: creators })
    .from(communities)
    .innerJoin(creators, eq(creators.id, communities.creatorId))
    .where(eq(communities.slug, slug))
    .limit(1);
  if (!row) return null;
  const isOwnerPreview = opts.previewCreatorId === row.community.creatorId;
  if (row.community.status !== "published" && !isOwnerPreview) return null;

  const [plan] = await db
    .select({ plan: membershipPlans, price: planPrices })
    .from(membershipPlans)
    .innerJoin(planPrices, eq(planPrices.id, membershipPlans.currentPriceId))
    .where(and(eq(membershipPlans.communityId, row.community.id), eq(membershipPlans.status, "active")))
    .limit(1);
  const [merchant] = await db.select().from(merchantAccounts).where(eq(merchantAccounts.creatorId, row.creator.id)).limit(1);
  const [chat] = await db.select().from(telegramChats).where(eq(telegramChats.communityId, row.community.id)).limit(1);

  const acceptingMembers =
    row.community.status === "published" &&
    !row.community.isDemo &&
    Boolean(plan?.price.stripePriceId) &&
    Boolean(merchant && isMerchantReady(merchant)) &&
    chat?.status === "connected";

  return {
    community: row.community,
    creatorName: row.creator.displayName,
    plan: plan ? { id: plan.plan.id, name: plan.plan.name, description: plan.plan.description, amountMinor: plan.price.amountMinor, currency: plan.price.currency } : null,
    chatType: chat?.chatType ?? null,
    acceptingMembers,
    isOwnerPreview,
  };
}

export async function getActiveEntitlement(db: DbOrTx, userId: string, communityId: string, now: Date) {
  const [e] = await db
    .select()
    .from(entitlements)
    .where(and(eq(entitlements.userId, userId), eq(entitlements.communityId, communityId), eq(entitlements.status, "active"), gt(entitlements.accessEndsAt, now)))
    .limit(1);
  return e ?? null;
}

/**
 * Create a Checkout Session on the creator's connected account (direct charge).
 * Price, account and community all come from the database; nothing from the client except the slug.
 */
export async function createCheckout(
  deps: Deps,
  user: { id: string; telegramUserId: number; firstName: string; lastName: string | null; telegramUsername: string | null },
  slug: string,
): Promise<{ url: string; intentId: string }> {
  const [row] = await deps.db
    .select({ community: communities, creator: creators, merchant: merchantAccounts, chat: telegramChats })
    .from(communities)
    .innerJoin(creators, eq(creators.id, communities.creatorId))
    .innerJoin(merchantAccounts, eq(merchantAccounts.creatorId, creators.id))
    .innerJoin(telegramChats, eq(telegramChats.communityId, communities.id))
    .where(and(eq(communities.slug, slug), eq(communities.status, "published")))
    .limit(1);
  if (!row || row.community.isDemo) throw new NotFoundError("This membership isn't available.");
  if (!isMerchantReady(row.merchant)) throw new AppError("merchant_not_ready", "This community isn't accepting payments right now.");
  if (row.chat.status !== "connected") throw new AppError("chat_unavailable", "This community is temporarily unavailable. Please try again later.");

  const [plan] = await deps.db
    .select({ plan: membershipPlans, price: planPrices })
    .from(membershipPlans)
    .innerJoin(planPrices, eq(planPrices.id, membershipPlans.currentPriceId))
    .where(and(eq(membershipPlans.communityId, row.community.id), eq(membershipPlans.status, "active"), eq(membershipPlans.merchantAccountId, row.merchant.id)))
    .limit(1);
  if (!plan?.price.stripePriceId) throw new AppError("no_plan", "This community has no active plan.");

  if (await getActiveEntitlement(deps.db, user.id, row.community.id, deps.now())) {
    throw new AppError("already_member", "You already have an active membership for this community.");
  }

  const customer = await ensureSubscriberCustomer(deps, user, row.merchant);

  const [intent] = await deps.db
    .insert(checkoutIntents)
    .values({
      userId: user.id,
      creatorId: row.creator.id,
      communityId: row.community.id,
      planId: plan.plan.id,
      planPriceId: plan.price.id,
      merchantAccountId: row.merchant.id,
      subscriberCustomerId: customer.id,
      stripeAccountId: row.merchant.stripeAccountId,
    })
    .returning();
  if (!intent) throw new Error("insert failed");

  const metadata = { flock_checkout_intent_id: intent.id, flock_community_id: row.community.id, flock_user_id: user.id };
  const base = deps.config.appUrl;
  const session = await deps.stripe.createSubscriptionCheckout(
    row.merchant.stripeAccountId,
    {
      customerId: customer.stripeCustomerId,
      priceId: plan.price.stripePriceId,
      clientReferenceId: intent.id,
      metadata,
      successUrl: `${base}/join/${row.community.slug}/status?intent=${intent.id}`,
      cancelUrl: `${base}/join/${row.community.slug}?checkout=canceled`,
    },
    `flock-checkout:${intent.id}`,
  );
  if (!session.url) throw new Error("Stripe returned no checkout URL");
  await deps.db.update(checkoutIntents).set({ status: "open", stripeCheckoutSessionId: session.id }).where(eq(checkoutIntents.id, intent.id));
  await track(deps.db, ANALYTICS.checkoutStarted, { userId: user.id, creatorId: row.creator.id, communityId: row.community.id }, { amountMinor: plan.price.amountMinor, currency: plan.price.currency });
  return { url: session.url, intentId: intent.id };
}

async function ensureSubscriberCustomer(
  deps: Deps,
  user: { id: string; telegramUserId: number; firstName: string; lastName: string | null; telegramUsername: string | null },
  merchant: typeof merchantAccounts.$inferSelect,
) {
  const find = async () =>
    (
      await deps.db
        .select()
        .from(subscriberCustomers)
        .where(and(eq(subscriberCustomers.merchantAccountId, merchant.id), eq(subscriberCustomers.userId, user.id)))
        .limit(1)
    )[0];
  const existing = await find();
  if (existing) return existing;
  const created = await deps.stripe.createCustomer(
    merchant.stripeAccountId,
    {
      name: displayTelegramName(user),
      metadata: { flock_user_id: user.id, telegram_user_id: String(user.telegramUserId), ...(user.telegramUsername ? { telegram_username: user.telegramUsername } : {}) },
    },
    `flock-customer:${merchant.id}:${user.id}`,
  );
  await deps.db
    .insert(subscriberCustomers)
    .values({ userId: user.id, merchantAccountId: merchant.id, stripeCustomerId: created.id })
    .onConflictDoNothing();
  const row = await find();
  if (!row) throw new Error("customer insert race");
  return row;
}

export type MembershipStatusView =
  | { state: "confirming" }
  | { state: "payment_failed" }
  | { state: "checkout_expired" }
  | { state: "preparing_access" }
  | { state: "access_problem"; message: string }
  | { state: "invite_ready"; inviteLink: string; expiresAt: Date | null }
  | { state: "join_pending"; inviteLink: string | null }
  | { state: "member" }
  | { state: "ended"; endedAt: Date | null };

/**
 * Server-side view for the post-checkout status page. Scoped to the session user.
 * Never reports access unless the entitlement is active in our database.
 */
export async function getCheckoutStatus(deps: Pick<Deps, "db" | "now">, userId: string, intentId: string) {
  const [intent] = await deps.db
    .select()
    .from(checkoutIntents)
    .where(and(eq(checkoutIntents.id, intentId), eq(checkoutIntents.userId, userId)))
    .limit(1);
  if (!intent) return null;

  const [sub] = await deps.db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.communityId, intent.communityId)))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  const [ent] = sub ? await deps.db.select().from(entitlements).where(eq(entitlements.subscriptionId, sub.id)).limit(1) : [];
  const [grant] = await deps.db
    .select()
    .from(telegramAccessGrants)
    .where(and(eq(telegramAccessGrants.userId, userId), eq(telegramAccessGrants.communityId, intent.communityId)))
    .limit(1);

  const view = statusView(intent, sub ?? null, ent ?? null, grant ?? null, deps.now());
  return { intent, view, subscription: sub ?? null, entitlement: ent ?? null };
}

function statusView(
  intent: typeof checkoutIntents.$inferSelect,
  sub: typeof subscriptions.$inferSelect | null,
  ent: typeof entitlements.$inferSelect | null,
  grant: typeof telegramAccessGrants.$inferSelect | null,
  now: Date,
): MembershipStatusView {
  const active = ent?.status === "active" && ent.accessEndsAt !== null && ent.accessEndsAt > now;
  if (active) {
    if (!grant || grant.state === "pending" || grant.state === "revoking") return { state: "preparing_access" };
    if (grant.state === "member") return { state: "member" };
    if (grant.state === "failed") {
      return { state: "access_problem", message: grant.lastErrorCode === "banned_by_admin" ? "A community admin has banned this Telegram account. Contact the community's support." : "We're having trouble creating your invite. We'll keep retrying automatically." };
    }
    if (grant.state === "invited" && grant.inviteLink) {
      if (grant.note === "join_requested") return { state: "join_pending", inviteLink: grant.inviteLink };
      return { state: "invite_ready", inviteLink: grant.inviteLink, expiresAt: grant.inviteLinkExpiresAt };
    }
    return { state: "preparing_access" };
  }
  if (ent?.status === "ended") return { state: "ended", endedAt: ent.endedAt };
  if (sub && (sub.status === "incomplete_expired" || sub.status === "incomplete")) return { state: "payment_failed" };
  if (intent.status === "expired") return { state: "checkout_expired" };
  if (intent.status === "failed") return { state: "payment_failed" };
  return { state: "confirming" };
}

/**
 * The success redirect proves nothing, but it's a good moment to ask Stripe directly.
 * Enqueues a server-side check of the Checkout Session (deduped).
 */
export async function requestCheckoutVerification(db: DbOrTx, intentId: string) {
  await enqueue(db, "stripe.sync_checkout", { checkoutIntentId: intentId }, { dedupeKey: `sync_checkout:${intentId}`, maxAttempts: 3 });
}
