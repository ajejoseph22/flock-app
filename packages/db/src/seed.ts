/**
 * DEMO SEED DATA — for local development and screenshots only.
 *
 * Everything created here is flagged `is_demo = true` and uses identifiers that can't collide with real
 * Telegram or Stripe objects (negative Telegram user IDs, `acct_demo_*` / `sub_demo_*` Stripe IDs).
 * Demo communities can't take payments (checkout refuses `is_demo`), and reconciliation never sends
 * demo rows to Stripe or Telegram. Refuses to run when FLOCK_ENV=production.
 *
 *   pnpm db:seed            create the demo community (no-op if it exists)
 *   pnpm db:seed --reset    delete all demo data, then recreate it
 *
 * Set SEED_OWNER_TELEGRAM_USER_ID to your own Telegram user ID (after signing in once locally)
 * to own the demo community and browse it in the dashboard.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { createDb, type Tx } from "./client";
import * as s from "./schema";

const DEMO_SLUG = "demo-market-notes";
const DAY = 86_400_000;

const MEMBERS = [
  { first: "Ada", last: "Demo", username: "ada_demo", scenario: "active", joinedDaysAgo: 120 },
  { first: "Ben", last: "Demo", username: "ben_demo", scenario: "active", joinedDaysAgo: 64 },
  { first: "Chi", last: null, username: "chi_demo", scenario: "active", joinedDaysAgo: 33 },
  { first: "Dara", last: "Demo", username: null, scenario: "active", joinedDaysAgo: 9 },
  { first: "Eli", last: "Demo", username: "eli_demo", scenario: "grace", joinedDaysAgo: 61 },
  { first: "Femi", last: "Demo", username: "femi_demo", scenario: "ending", joinedDaysAgo: 88 },
  { first: "Gus", last: "Demo", username: "gus_demo", scenario: "ended", joinedDaysAgo: 150 },
  { first: "Hana", last: "Demo", username: "hana_demo", scenario: "refunded", joinedDaysAgo: 20 },
] as const;

async function main() {
  if (process.env.FLOCK_ENV === "production") throw new Error("Refusing to seed demo data in production.");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const reset = process.argv.includes("--reset");
  const handle = createDb(url, { max: 1, applicationName: "flock-seed" });
  try {
    await handle.db.transaction(async (tx) => {
      if (reset) await deleteDemoData(tx);
      const [existing] = await tx.select({ id: s.communities.id }).from(s.communities).where(eq(s.communities.slug, DEMO_SLUG));
      if (existing) {
        console.log(`Demo community already exists (/join/${DEMO_SLUG}). Use --reset to recreate it.`);
        return;
      }
      await seed(tx);
      console.log(`Seeded DEMO data: /join/${DEMO_SLUG} with ${MEMBERS.length} demo members.`);
    });
  } finally {
    await handle.close();
  }
}

async function deleteDemoData(tx: Tx) {
  const demoCommunities = (await tx.select({ id: s.communities.id }).from(s.communities).where(eq(s.communities.isDemo, true))).map((r) => r.id);
  if (demoCommunities.length) {
    const c = inArray;
    await tx.delete(s.auditLogs).where(c(s.auditLogs.communityId, demoCommunities));
    await tx.delete(s.analyticsEvents).where(c(s.analyticsEvents.communityId, demoCommunities));
    await tx.delete(s.telegramAccessGrants).where(c(s.telegramAccessGrants.communityId, demoCommunities));
    await tx.delete(s.entitlements).where(c(s.entitlements.communityId, demoCommunities));
    await tx.delete(s.invoices).where(c(s.invoices.communityId, demoCommunities));
    await tx.delete(s.subscriptions).where(c(s.subscriptions.communityId, demoCommunities));
    await tx.delete(s.checkoutIntents).where(c(s.checkoutIntents.communityId, demoCommunities));
    const plans = (await tx.select({ id: s.membershipPlans.id }).from(s.membershipPlans).where(c(s.membershipPlans.communityId, demoCommunities))).map((r) => r.id);
    if (plans.length) {
      await tx.update(s.membershipPlans).set({ currentPriceId: null }).where(c(s.membershipPlans.id, plans));
      await tx.delete(s.planPrices).where(c(s.planPrices.planId, plans));
      await tx.delete(s.membershipPlans).where(c(s.membershipPlans.id, plans));
    }
    await tx.delete(s.telegramChats).where(c(s.telegramChats.communityId, demoCommunities));
    await tx.delete(s.chatConnectionRequests).where(c(s.chatConnectionRequests.communityId, demoCommunities));
    await tx.delete(s.communities).where(c(s.communities.id, demoCommunities));
  }
  const demoCreators = (await tx.select({ id: s.creators.id }).from(s.creators).where(eq(s.creators.isDemo, true))).map((r) => r.id);
  if (demoCreators.length) {
    const merchants = (await tx.select({ id: s.merchantAccounts.id }).from(s.merchantAccounts).where(inArray(s.merchantAccounts.creatorId, demoCreators))).map((r) => r.id);
    if (merchants.length) {
      await tx.delete(s.subscriberCustomers).where(inArray(s.subscriberCustomers.merchantAccountId, merchants));
      await tx.delete(s.merchantAccounts).where(inArray(s.merchantAccounts.id, merchants));
    }
    // A real owner (SEED_OWNER_TELEGRAM_USER_ID) keeps their user row; only demo users are removed.
    await tx.delete(s.creators).where(and(inArray(s.creators.id, demoCreators), sql`${s.creators.userId} in (select id from users where is_demo)`));
    await tx.update(s.creators).set({ isDemo: false }).where(inArray(s.creators.id, demoCreators));
  }
  await tx.delete(s.users).where(eq(s.users.isDemo, true));
}

async function seed(tx: Tx) {
  const now = Date.now();
  const at = (daysFromNow: number) => new Date(now + daysFromNow * DAY);

  // Creator: either a real local user (opt-in) or a demo user.
  let ownerUserId: string;
  const ownerTelegramId = process.env.SEED_OWNER_TELEGRAM_USER_ID ? Number(process.env.SEED_OWNER_TELEGRAM_USER_ID) : null;
  if (ownerTelegramId) {
    const [owner] = await tx.select().from(s.users).where(eq(s.users.telegramUserId, ownerTelegramId));
    if (!owner) throw new Error(`No user with Telegram ID ${ownerTelegramId}. Sign in to Flock locally once, then re-run the seed.`);
    const [hasCommunity] = await tx
      .select({ id: s.communities.id })
      .from(s.communities)
      .innerJoin(s.creators, eq(s.creators.id, s.communities.creatorId))
      .where(eq(s.creators.userId, owner.id));
    if (hasCommunity) throw new Error("That user already has a community; creators can have one during early access.");
    ownerUserId = owner.id;
  } else {
    const [u] = await tx.insert(s.users).values({ telegramUserId: -900_000_000, firstName: "Demo", lastName: "Creator", telegramUsername: "demo_creator", isDemo: true }).returning();
    ownerUserId = u!.id;
  }
  const [creator] = await tx
    .insert(s.creators)
    .values({ userId: ownerUserId, displayName: "Demo Creator", contactEmail: "demo@example.com", isDemo: true })
    .onConflictDoUpdate({ target: s.creators.userId, set: { isDemo: true } })
    .returning();

  const [merchant] = await tx
    .insert(s.merchantAccounts)
    .values({
      creatorId: creator!.id,
      stripeAccountId: `acct_demo_${creator!.id.slice(0, 8)}`,
      livemode: false,
      cardPaymentsStatus: "active",
      requirementsStatus: null,
      displayName: "Demo Creator",
      country: "US",
      defaultCurrency: "usd",
      lastSyncedAt: new Date(),
    })
    .returning();

  const [community] = await tx
    .insert(s.communities)
    .values({
      creatorId: creator!.id,
      name: "Demo: Market Morning Notes",
      slug: DEMO_SLUG,
      description: "DEMO COMMUNITY with sample data. A daily pre-market briefing with charts and a weekly live Q&A.",
      benefits: ["Daily pre-market notes", "Weekly live Q&A", "Archive of past notes"],
      supportContact: "@demo_creator",
      status: "published",
      publishedAt: at(-150),
      isDemo: true,
    })
    .returning();
  const communityId = community!.id;

  await tx.insert(s.telegramChats).values({
    communityId,
    telegramChatId: -1_009_000_000_001,
    chatType: "channel",
    title: "Market Morning Notes (demo)",
    status: "connected",
    botCanInviteUsers: true,
    botCanRestrictMembers: true,
    connectedByUserId: ownerUserId,
    connectedAt: at(-150),
  });

  const [plan] = await tx
    .insert(s.membershipPlans)
    .values({ communityId, merchantAccountId: merchant!.id, name: "Monthly membership", stripeProductId: `prod_demo_${communityId.slice(0, 8)}` })
    .returning();
  const [price] = await tx
    .insert(s.planPrices)
    .values({ planId: plan!.id, amountMinor: 1900, currency: "usd", stripePriceId: `price_demo_${communityId.slice(0, 8)}` })
    .returning();
  await tx.update(s.membershipPlans).set({ currentPriceId: price!.id }).where(eq(s.membershipPlans.id, plan!.id));

  let n = 0;
  for (const m of MEMBERS) {
    n++;
    const [user] = await tx
      .insert(s.users)
      .values({ telegramUserId: -900_000_000 - n, firstName: m.first, lastName: m.last, telegramUsername: m.username, isDemo: true })
      .returning();
    const [customer] = await tx
      .insert(s.subscriberCustomers)
      .values({ userId: user!.id, merchantAccountId: merchant!.id, stripeCustomerId: `cus_demo_${n}_${communityId.slice(0, 6)}` })
      .returning();

    // Period math: monthly periods since join; the current one ends somewhere in the next 30 days.
    const periods = Math.floor(m.joinedDaysAgo / 30) + 1;
    const start = at(-m.joinedDaysAgo);
    const currentStart = new Date(start.getTime() + (periods - 1) * 30 * DAY);
    const currentEnd = new Date(currentStart.getTime() + 30 * DAY);

    const scenario = m.scenario;
    const status = scenario === "grace" ? "past_due" : scenario === "ended" || scenario === "refunded" ? "canceled" : "active";
    const endedAt = scenario === "ended" ? at(-20) : scenario === "refunded" ? at(-2) : null;
    const paidPeriods = scenario === "grace" ? periods - 1 : scenario === "ended" ? Math.max(1, periods - 1) : periods;
    const paidThrough =
      scenario === "refunded" ? null : scenario === "ended" ? at(-20) : new Date(start.getTime() + paidPeriods * 30 * DAY);

    const [sub] = await tx
      .insert(s.subscriptions)
      .values({
        merchantAccountId: merchant!.id,
        stripeSubscriptionId: `sub_demo_${n}_${communityId.slice(0, 6)}`,
        userId: user!.id,
        communityId,
        planId: plan!.id,
        planPriceId: price!.id,
        subscriberCustomerId: customer!.id,
        status,
        cancelAtPeriodEnd: scenario === "ending",
        canceledAt: scenario === "ending" ? at(-3) : endedAt,
        endedAt,
        currentPeriodStart: scenario === "ended" ? new Date(at(-20).getTime() - 30 * DAY) : currentStart,
        currentPeriodEnd: scenario === "ended" ? at(-20) : currentEnd,
        paidThrough,
        latestInvoiceRefunded: scenario === "refunded",
        amountMinor: 1900,
        currency: "usd",
        stripeCreatedAt: start,
      })
      .returning();

    const invoiceCount = scenario === "grace" ? periods : paidPeriods;
    for (let i = 0; i < invoiceCount; i++) {
      const pStart = new Date(start.getTime() + i * 30 * DAY);
      const unpaid = scenario === "grace" && i === invoiceCount - 1;
      await tx.insert(s.invoices).values({
        subscriptionId: sub!.id,
        merchantAccountId: merchant!.id,
        communityId,
        userId: user!.id,
        stripeInvoiceId: `in_demo_${n}_${i}_${communityId.slice(0, 6)}`,
        status: unpaid ? "open" : "paid",
        amountPaidMinor: unpaid ? 0 : 1900,
        currency: "usd",
        periodEnd: new Date(pStart.getTime() + 30 * DAY),
        paidAt: unpaid ? null : pStart,
        refunded: scenario === "refunded",
      });
    }

    const active = scenario === "active" || scenario === "grace" || scenario === "ending";
    const accessEndsAt = scenario === "grace" ? at(1) : scenario === "ending" ? currentEnd : active ? currentEnd : endedAt;
    await tx.insert(s.entitlements).values({
      subscriptionId: sub!.id,
      userId: user!.id,
      communityId,
      status: active ? "active" : "ended",
      reason: scenario === "grace" ? "grace_period" : scenario === "ending" ? "canceled_until_period_end" : scenario === "refunded" ? "refunded" : active ? "active" : "expired",
      accessEndsAt,
      activatedAt: start,
      endedAt: active ? null : endedAt,
    });

    const joinedAt = new Date(start.getTime() + 10 * 60_000);
    await tx.insert(s.telegramAccessGrants).values({
      userId: user!.id,
      communityId,
      state: active ? "member" : "revoked",
      desired: active,
      joinedAt,
      revokedAt: active ? null : endedAt,
      lastCheckedAt: new Date(),
    });

    const log = (action: string, when: Date, actorType = "system") =>
      tx.insert(s.auditLogs).values({ actorType, creatorId: creator!.id, communityId, subjectUserId: user!.id, action, createdAt: when, details: { demo: true } });
    await log("entitlement.activated", start, "stripe");
    await log("access.invite_issued", new Date(start.getTime() + 60_000));
    await log("access.join_approved", joinedAt, "telegram");
    if (!active) {
      await log("entitlement.ended", endedAt!, "stripe");
      await log("access.revoked", new Date(endedAt!.getTime() + 60_000));
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
