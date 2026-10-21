import { auditLogs, entitlements, invoices, membershipPlans, subscriptions, telegramAccessGrants, telegramChats, users, type DbOrTx } from "@flock/db";
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { monthlyEquivalentMinor } from "../domain/money";

const LIVE_STATUSES = ["active", "past_due", "trialing"];

/**
 * Creator dashboard KPIs, computed from the database only (no invented numbers).
 * Amounts are grouped by currency; never summed across currencies.
 */
export async function getDashboardStats(db: DbOrTx, communityId: string, now: Date) {
  const activeEnts = await db
    .select({ userId: entitlements.userId, subscriptionId: entitlements.subscriptionId })
    .from(entitlements)
    .where(and(eq(entitlements.communityId, communityId), eq(entitlements.status, "active"), sql`${entitlements.accessEndsAt} > ${now.toISOString()}::timestamptz`));
  const activeMembers = new Set(activeEnts.map((e) => e.userId)).size;

  const liveSubs = activeEnts.length
    ? await db
        .select({ amountMinor: subscriptions.amountMinor, currency: subscriptions.currency, status: subscriptions.status, cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd })
        .from(subscriptions)
        .where(and(inArray(subscriptions.id, activeEnts.map((e) => e.subscriptionId)), inArray(subscriptions.status, LIVE_STATUSES)))
    : [];
  const mrr: Record<string, number> = {};
  // MRR counts only subscriptions that will renew; ones set to cancel at period end are excluded.
  for (const s of liveSubs.filter((x) => !x.cancelAtPeriodEnd)) mrr[s.currency] = (mrr[s.currency] ?? 0) + monthlyEquivalentMinor(s.amountMinor, "month", 1);

  const recentPayments = await db
    .select({ invoice: invoices, user: users })
    .from(invoices)
    .innerJoin(users, eq(users.id, invoices.userId))
    .where(and(eq(invoices.communityId, communityId), eq(invoices.status, "paid")))
    .orderBy(desc(invoices.paidAt))
    .limit(6);

  const recentCancellations = await db
    .select({ subscription: subscriptions, user: users })
    .from(subscriptions)
    .innerJoin(users, eq(users.id, subscriptions.userId))
    .where(and(eq(subscriptions.communityId, communityId), or(eq(subscriptions.status, "canceled"), eq(subscriptions.cancelAtPeriodEnd, true))))
    .orderBy(desc(sql`coalesce(${subscriptions.canceledAt}, ${subscriptions.updatedAt})`))
    .limit(6);

  const attention = await getAttentionList(db, communityId, now);
  return { activeMembers, activeSubscriptions: liveSubs.length, mrr, recentPayments, recentCancellations, attention };
}

export interface AttentionItem {
  userId: string | null;
  name: string;
  issue: string;
  detail: string | null;
}

/** Members (and the chat) needing the creator's attention. */
export async function getAttentionList(db: DbOrTx, communityId: string, now: Date): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  const [chat] = await db.select().from(telegramChats).where(eq(telegramChats.communityId, communityId)).limit(1);
  if (chat?.status === "needs_attention") items.push({ userId: null, name: chat.title, issue: "Telegram chat needs attention", detail: chat.statusReason });

  const failed = await db
    .select({ grant: telegramAccessGrants, user: users })
    .from(telegramAccessGrants)
    .innerJoin(users, eq(users.id, telegramAccessGrants.userId))
    .where(and(eq(telegramAccessGrants.communityId, communityId), eq(telegramAccessGrants.state, "failed")))
    .limit(20);
  for (const f of failed) items.push({ userId: f.user.id, name: nameOf(f.user), issue: f.grant.desired ? "Access couldn't be granted" : "Removal failed", detail: f.grant.lastError });

  const stuckRevokes = await db
    .select({ grant: telegramAccessGrants, user: users })
    .from(telegramAccessGrants)
    .innerJoin(users, eq(users.id, telegramAccessGrants.userId))
    .where(
      and(
        eq(telegramAccessGrants.communityId, communityId),
        eq(telegramAccessGrants.state, "revoking"),
        sql`${telegramAccessGrants.updatedAt} < ${new Date(now.getTime() - 15 * 60_000).toISOString()}::timestamptz`,
      ),
    )
    .limit(20);
  for (const f of stuckRevokes) items.push({ userId: f.user.id, name: nameOf(f.user), issue: "Removal is being retried", detail: f.grant.lastError });

  const pastDue = await db
    .select({ subscription: subscriptions, user: users })
    .from(subscriptions)
    .innerJoin(users, eq(users.id, subscriptions.userId))
    .where(and(eq(subscriptions.communityId, communityId), eq(subscriptions.status, "past_due")))
    .limit(20);
  for (const p of pastDue) items.push({ userId: p.user.id, name: nameOf(p.user), issue: "Renewal payment failed", detail: "Stripe is retrying; access continues during the grace period." });
  return items;
}

function nameOf(u: { firstName: string; lastName: string | null; telegramUsername: string | null }) {
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || (u.telegramUsername ? `@${u.telegramUsername}` : "Telegram user");
}

export type MemberSort = "joined" | "renewal" | "name" | "status";

export interface MemberRow {
  userId: string;
  name: string;
  username: string | null;
  telegramUserId: number;
  subscriptionStatus: string;
  entitlementStatus: string | null;
  entitlementReason: string | null;
  planName: string;
  joinedAt: Date | null;
  subscribedAt: Date;
  nextDate: Date | null;
  nextDateKind: "renews" | "ends" | "ended" | null;
  accessState: string | null;
}

/** Members table: one row per subscriber (their most recent subscription), searchable and sortable server-side. */
export async function listMembers(db: DbOrTx, communityId: string, opts: { q?: string; sort?: MemberSort; dir?: "asc" | "desc"; limit?: number } = {}) {
  const filters: SQL[] = [eq(subscriptions.communityId, communityId)];
  const q = opts.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`).replace(/^@/, "")}%`;
    const numeric = /^\d{3,15}$/.test(q) ? Number(q) : null;
    filters.push(
      or(ilike(users.firstName, like), ilike(users.lastName, like), ilike(users.telegramUsername, like), ...(numeric ? [eq(users.telegramUserId, numeric)] : []))!,
    );
  }
  const rows = await db
    .selectDistinctOn([subscriptions.userId], {
      subscription: subscriptions,
      user: users,
      entitlement: entitlements,
      grant: telegramAccessGrants,
      planName: membershipPlans.name,
    })
    .from(subscriptions)
    .innerJoin(users, eq(users.id, subscriptions.userId))
    .innerJoin(membershipPlans, eq(membershipPlans.id, subscriptions.planId))
    .leftJoin(entitlements, eq(entitlements.subscriptionId, subscriptions.id))
    .leftJoin(telegramAccessGrants, and(eq(telegramAccessGrants.userId, subscriptions.userId), eq(telegramAccessGrants.communityId, subscriptions.communityId)))
    .where(and(...filters))
    .orderBy(asc(subscriptions.userId), desc(subscriptions.createdAt))
    .limit(opts.limit ?? 500);

  const members: MemberRow[] = rows.map((r) => {
    const active = r.entitlement?.status === "active";
    const ending = r.subscription.cancelAtPeriodEnd || r.subscription.status === "canceled";
    return {
      userId: r.user.id,
      name: nameOf(r.user),
      username: r.user.telegramUsername,
      telegramUserId: r.user.telegramUserId,
      subscriptionStatus: r.subscription.status,
      entitlementStatus: r.entitlement?.status ?? null,
      entitlementReason: r.entitlement?.reason ?? null,
      planName: r.planName,
      joinedAt: r.grant?.joinedAt ?? null,
      subscribedAt: r.subscription.createdAt,
      nextDate: active ? (ending ? r.entitlement!.accessEndsAt : r.subscription.currentPeriodEnd) : (r.entitlement?.endedAt ?? null),
      nextDateKind: active ? (ending ? "ends" : "renews") : r.entitlement ? "ended" : null,
      accessState: r.grant?.state ?? null,
    };
  });

  const dir = opts.dir === "asc" ? 1 : -1;
  const t = (d: Date | null) => d?.getTime() ?? 0;
  const sorters: Record<MemberSort, (a: MemberRow, b: MemberRow) => number> = {
    joined: (a, b) => (t(a.joinedAt ?? a.subscribedAt) - t(b.joinedAt ?? b.subscribedAt)) * dir,
    renewal: (a, b) => (t(a.nextDate) - t(b.nextDate)) * dir,
    name: (a, b) => a.name.localeCompare(b.name) * dir,
    status: (a, b) => (a.entitlementStatus ?? "").localeCompare(b.entitlementStatus ?? "") * dir,
  };
  members.sort(sorters[opts.sort ?? "joined"]);
  return members;
}

/** Member detail + timeline, strictly within the creator's community. */
export async function getMemberDetail(db: DbOrTx, communityId: string, userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return null;
  const subs = await db
    .select({ subscription: subscriptions, entitlement: entitlements, planName: membershipPlans.name })
    .from(subscriptions)
    .innerJoin(membershipPlans, eq(membershipPlans.id, subscriptions.planId))
    .leftJoin(entitlements, eq(entitlements.subscriptionId, subscriptions.id))
    .where(and(eq(subscriptions.communityId, communityId), eq(subscriptions.userId, userId)))
    .orderBy(desc(subscriptions.createdAt));
  if (subs.length === 0) return null; // not a member of this community → not visible to this creator
  const [grant] = await db
    .select()
    .from(telegramAccessGrants)
    .where(and(eq(telegramAccessGrants.communityId, communityId), eq(telegramAccessGrants.userId, userId)))
    .limit(1);
  const timeline = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.communityId, communityId), eq(auditLogs.subjectUserId, userId)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(100);
  const payments = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.communityId, communityId), eq(invoices.userId, userId)))
    .orderBy(desc(invoices.paidAt))
    .limit(50);
  return { user, subscriptions: subs, grant: grant ?? null, timeline, payments };
}
