import { communities, creators, entitlements, merchantAccounts, subscriptions, telegramAccessGrants, telegramChats, users, webhookEvents, analyticsEvents } from "@flock/db";
import { and, asc, eq, gt, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { enqueue, pruneJobs } from "../jobs/queue";
import { TelegramApiError } from "../errors";
import { pruneAuth } from "./auth";
import { recomputeEntitlementLocally } from "./billing-sync";
import { expireConnectionRequests, refreshConnectedChat } from "./chat-connection";
import { requeueStuckWebhookEvents } from "./webhooks";

/** If Stripe can't be reached for this long past access end, fall back to local data (fail closed eventually). */
const LOCAL_FALLBACK_AFTER_MS = 6 * 3_600_000;

/**
 * Every minute: entitlements whose access_ends_at passed. We re-check Stripe before revoking
 * (a missed renewal webhook must not remove a paying member); after 6h without a successful
 * sync we fall back to local state so access can't stay open indefinitely.
 * Demo communities (seed data) are never sent to Stripe or Telegram.
 */
export async function runExpirySweep(deps: Deps) {
  const now = deps.now();
  const due = await deps.db
    .select({ entitlement: entitlements, subscription: subscriptions, stripeAccountId: merchantAccounts.stripeAccountId })
    .from(entitlements)
    .innerJoin(subscriptions, eq(subscriptions.id, entitlements.subscriptionId))
    .innerJoin(merchantAccounts, eq(merchantAccounts.id, subscriptions.merchantAccountId))
    .innerJoin(communities, eq(communities.id, entitlements.communityId))
    .where(and(eq(entitlements.status, "active"), lt(entitlements.accessEndsAt, now), eq(communities.isDemo, false)))
    .limit(500);
  let synced = 0;
  let local = 0;
  for (const row of due) {
    const overdue = now.getTime() - (row.entitlement.accessEndsAt?.getTime() ?? now.getTime()) > LOCAL_FALLBACK_AFTER_MS;
    const staleSync = row.subscription.lastSyncedAt.getTime() < (row.entitlement.accessEndsAt?.getTime() ?? 0);
    if (overdue || !staleSync) {
      // Already synced after access ended (Stripe confirmed), or Stripe unreachable for too long.
      await recomputeEntitlementLocally(deps, row.subscription.id);
      local++;
    } else {
      await enqueue(
        deps.db,
        "stripe.sync_subscription",
        { stripeAccountId: row.stripeAccountId, stripeSubscriptionId: row.subscription.stripeSubscriptionId },
        { dedupeKey: `sync:${row.subscription.id}`, maxAttempts: 5 },
      );
      synced++;
    }
  }
  await expireConnectionRequests(deps.db, now);
  return { due: due.length, synced, local };
}

/**
 * Hourly safety net (OPS-3): re-sync subscriptions from Stripe, repair grant drift,
 * spot-check Telegram membership, refresh merchants and chat permissions.
 */
export async function runReconciliation(deps: Deps, limits = { subscriptions: 200, grants: 500, memberChecks: 50, merchants: 50, chats: 50 }) {
  const now = deps.now();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3_600_000);
  const hourAgo = new Date(now.getTime() - 3_600_000);

  // 1. Subscriptions not terminal, or ended within the last week, least recently synced first.
  const subs = await deps.db
    .select({ id: subscriptions.id, stripeSubscriptionId: subscriptions.stripeSubscriptionId, stripeAccountId: merchantAccounts.stripeAccountId })
    .from(subscriptions)
    .innerJoin(merchantAccounts, eq(merchantAccounts.id, subscriptions.merchantAccountId))
    .innerJoin(communities, eq(communities.id, subscriptions.communityId))
    .where(
      and(
        eq(communities.isDemo, false),
        lt(subscriptions.lastSyncedAt, hourAgo),
        or(notInArray(subscriptions.status, ["canceled", "incomplete_expired"]), gt(subscriptions.updatedAt, weekAgo)),
      ),
    )
    .orderBy(asc(subscriptions.lastSyncedAt))
    .limit(limits.subscriptions);
  for (const s of subs) {
    await enqueue(deps.db, "stripe.sync_subscription", { stripeAccountId: s.stripeAccountId, stripeSubscriptionId: s.stripeSubscriptionId }, { dedupeKey: `sync:${s.id}`, maxAttempts: 5 });
  }

  // 2. Grant drift: desired access vs grant state.
  const drift = await deps.db.execute<{ user_id: string; community_id: string }>(sql`
    select g.user_id, g.community_id from telegram_access_grants g
    join communities c on c.id = g.community_id and not c.is_demo
    where (
      g.state in ('pending', 'failed', 'revoking', 'revoked')
      and exists (select 1 from entitlements e where e.user_id = g.user_id and e.community_id = g.community_id and e.status = 'active' and e.access_ends_at > now())
    ) or (
      g.state in ('invited', 'member', 'pending', 'failed', 'revoking')
      and not exists (select 1 from entitlements e where e.user_id = g.user_id and e.community_id = g.community_id and e.status = 'active' and e.access_ends_at > now())
    )
    limit ${limits.grants}
  `);
  // Active entitlements with no grant at all.
  const missing = await deps.db.execute<{ user_id: string; community_id: string }>(sql`
    select distinct e.user_id, e.community_id from entitlements e
    join communities c on c.id = e.community_id and not c.is_demo
    where e.status = 'active' and e.access_ends_at > now()
      and not exists (select 1 from telegram_access_grants g where g.user_id = e.user_id and g.community_id = e.community_id)
    limit ${limits.grants}
  `);
  for (const r of [...drift.rows, ...missing.rows]) {
    await enqueue(deps.db, "access.reconcile", { userId: r.user_id, communityId: r.community_id }, { dedupeKey: `reconcile:${r.user_id}:${r.community_id}` });
  }

  // 3. Spot-check members (the Bot API can't list members, so we check known users).
  const members = await deps.db
    .select({ grant: telegramAccessGrants, telegramUserId: users.telegramUserId, telegramChatId: telegramChats.telegramChatId })
    .from(telegramAccessGrants)
    .innerJoin(users, eq(users.id, telegramAccessGrants.userId))
    .innerJoin(telegramChats, eq(telegramChats.communityId, telegramAccessGrants.communityId))
    .innerJoin(communities, eq(communities.id, telegramAccessGrants.communityId))
    .where(and(eq(telegramAccessGrants.state, "member"), eq(telegramChats.status, "connected"), eq(communities.isDemo, false)))
    .orderBy(sql`${telegramAccessGrants.lastCheckedAt} asc nulls first`)
    .limit(limits.memberChecks);
  let leftDetected = 0;
  for (const m of members) {
    try {
      const status = await deps.telegram.getChatMember(m.telegramChatId, m.telegramUserId);
      const inChat = status.status === "member" || status.status === "administrator" || status.status === "creator" || (status.status === "restricted" && status.isMember);
      await deps.db
        .update(telegramAccessGrants)
        .set(inChat ? { lastCheckedAt: now } : { lastCheckedAt: now, state: "left", note: "left_voluntarily" })
        .where(eq(telegramAccessGrants.id, m.grant.id));
      if (!inChat) leftDetected++;
    } catch (err) {
      if (err instanceof TelegramApiError && err.kind === "rate_limited") break;
      deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, "member spot-check failed");
    }
  }

  // 4. Merchants not refreshed in a day.
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000);
  const merchants = await deps.db
    .select({ stripeAccountId: merchantAccounts.stripeAccountId })
    .from(merchantAccounts)
    .innerJoin(creators, eq(creators.id, merchantAccounts.creatorId))
    .where(and(eq(creators.isDemo, false), or(lt(merchantAccounts.lastSyncedAt, dayAgo), sql`${merchantAccounts.lastSyncedAt} is null`)))
    .limit(limits.merchants);
  for (const m of merchants) {
    await enqueue(deps.db, "stripe.refresh_merchant", { stripeAccountId: m.stripeAccountId }, { dedupeKey: `merchant:${m.stripeAccountId}`, maxAttempts: 5 });
  }

  // 5. Chat permissions (catches a missed my_chat_member).
  const chats = await deps.db
    .select({ id: telegramChats.id })
    .from(telegramChats)
    .innerJoin(communities, eq(communities.id, telegramChats.communityId))
    .where(and(lt(telegramChats.lastVerifiedAt, hourAgo), eq(communities.isDemo, false)))
    .limit(limits.chats);
  for (const c of chats) {
    await refreshConnectedChat(deps, c.id).catch((err: unknown) => deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, "chat recheck failed"));
  }

  // 6. Webhook events that never got processed.
  const requeued = await requeueStuckWebhookEvents(deps.db, new Date(now.getTime() - 15 * 60_000));

  return { subscriptions: subs.length, grantRepairs: drift.rows.length + missing.rows.length, memberChecks: members.length, leftDetected, merchants: merchants.length, chats: chats.length, requeued };
}

/** Daily: prune expired auth state, old finished jobs, and raw webhook payloads beyond 30 days. */
export async function runRetention(deps: Deps) {
  const now = deps.now();
  await pruneAuth(deps.db, now);
  const jobsPruned = await pruneJobs(deps.db, new Date(now.getTime() - 14 * 24 * 3_600_000));
  const monthAgo = new Date(now.getTime() - 30 * 24 * 3_600_000);
  const events = await deps.db
    .delete(webhookEvents)
    .where(and(inArray(webhookEvents.status, ["processed", "ignored"]), lt(webhookEvents.receivedAt, monthAgo)))
    .returning({ id: webhookEvents.id });
  await deps.db.delete(analyticsEvents).where(lt(analyticsEvents.createdAt, new Date(now.getTime() - 400 * 24 * 3_600_000)));
  return { jobsPruned, eventsPruned: events.length };
}
