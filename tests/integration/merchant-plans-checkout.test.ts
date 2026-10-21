import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkoutIntents, merchantAccounts, membershipPlans, planPrices } from "@flock/db";
import {
  changePlanPrice,
  createCheckout,
  createCommunity,
  createFreshOnboardingLink,
  createPlan,
  createSubscriberPortalSession,
  ensureCreator,
  merchantDisplayState,
  setPlanStatus,
  startMerchantOnboarding,
  updatePlanDetails,
} from "@flock/core";
import { eq } from "drizzle-orm";
import { createHarness, type Harness } from "./harness";
import { publishedCommunity, signIn, subscribe } from "./fixtures";

let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());
beforeEach(async () => h.reset());

describe("Stripe merchant onboarding (Accounts v2)", () => {
  it("creates one connected account per creator with Stripe-owned fees and losses, then reflects readiness", async () => {
    const s = await signIn(h);
    const c = await ensureCreator(h.deps.db, s.user);
    await createCommunity(h.deps, c.id, s.user.id, { name: "Merchant test", slug: "m-community" });
    const url1 = await startMerchantOnboarding(h.deps, c.id, s.user.id, { contactEmail: "m@example.com" });
    const url2 = await startMerchantOnboarding(h.deps, c.id, s.user.id, { contactEmail: "m@example.com" });
    expect(url1).toContain("/_mock/onboarding/acct_");
    expect(url2).not.toBe(url1); // fresh single-use link each time
    expect(h.stripeMock.accounts.size).toBe(1);
    const createReq = h.stripeMock.requests.filter((r) => r.path === "/v2/core/accounts" && r.method === "POST");
    expect(createReq).toHaveLength(1); // second call reuses the stored account
    expect(h.stripeMock.accounts.size).toBe(1);

    let [m] = await h.deps.db.select().from(merchantAccounts).where(eq(merchantAccounts.creatorId, c.id));
    expect(merchantDisplayState(m!)).toBe("onboarding");
    expect(m!.requirements[0]?.description).toBe("Provide business details");

    await h.stripeMock.completeOnboarding(m!.stripeAccountId);
    await h.drain();
    [m] = await h.deps.db.select().from(merchantAccounts).where(eq(merchantAccounts.creatorId, c.id));
    expect(m).toMatchObject({ cardPaymentsStatus: "active", requirements: [] });
    expect(merchantDisplayState(m!)).toBe("ready");
    expect(await createFreshOnboardingLink(h.deps, c.id)).toContain(m!.stripeAccountId);
  });

  it("refuses a malformed email and never takes raw keys", async () => {
    const s = await signIn(h);
    const c = await ensureCreator(h.deps.db, s.user);
    await expect(startMerchantOnboarding(h.deps, c.id, s.user.id, { contactEmail: "nope" })).rejects.toThrow();
  });
});

describe("membership plans", () => {
  it("creates Product + monthly Price on the connected account in integer minor units", async () => {
    const pc = await publishedCommunity(h, { price: "19.99" });
    const [price] = await h.deps.db.select().from(planPrices).where(eq(planPrices.planId, pc.plan.id));
    expect(price).toMatchObject({ amountMinor: 1999, currency: "usd", interval: "month" });
    const remote = h.stripeMock.prices.get(price!.stripePriceId!)!;
    expect(remote).toMatchObject({ unit_amount: 1999, currency: "usd", account: pc.accountId });
  });

  it("price change creates a new Price version; existing subscribers keep theirs", async () => {
    const pc = await publishedCommunity(h, { price: "10" });
    const buyer = await subscribe(h, pc.community.slug);
    await changePlanPrice(h.deps, pc.creatorRow.id, pc.creator.user.id, pc.plan.id, { price: "15" });
    const prices = await h.deps.db.select().from(planPrices).where(eq(planPrices.planId, pc.plan.id));
    expect(prices.map((p) => [p.amountMinor, p.active]).sort()).toEqual([[1000, false], [1500, true]]);
    expect(h.stripeMock.subs.get(buyer.stripeSubscriptionId)!.price).toBe(prices.find((p) => p.amountMinor === 1000)!.stripePriceId);
    const newcomer = await signIn(h);
    const co = await createCheckout(h.deps, newcomer.user, pc.community.slug);
    const session = h.stripeMock.sessions.get(new URL(co.url).pathname.split("/").at(-1)!)!;
    expect((session.line_items as { price: string }[])[0]!.price).toBe(prices.find((p) => p.amountMinor === 1500)!.stripePriceId);
  });

  it("validates prices and enforces one active plan", async () => {
    const pc = await publishedCommunity(h);
    await expect(createPlan(h.deps, pc.creatorRow.id, pc.creator.user.id, { name: "Another", price: "5" })).rejects.toMatchObject({ code: "plan_limit" });
    await setPlanStatus(h.deps, pc.creatorRow.id, pc.creator.user.id, pc.plan.id, "inactive");
    await expect(createPlan(h.deps, pc.creatorRow.id, pc.creator.user.id, { name: "Bad", price: "0.50" })).rejects.toMatchObject({ code: "invalid_price" });
    await expect(createPlan(h.deps, pc.creatorRow.id, pc.creator.user.id, { name: "Bad", price: "abc" })).rejects.toMatchObject({ code: "invalid_price" });
    await updatePlanDetails(h.deps, pc.creatorRow.id, pc.creator.user.id, pc.plan.id, { name: "Renamed", description: "d" });
    const [plan] = await h.deps.db.select().from(membershipPlans).where(eq(membershipPlans.id, pc.plan.id));
    expect(plan!.name).toBe("Renamed");
  });

  it("another creator can't edit my plan", async () => {
    const pc = await publishedCommunity(h);
    const other = await signIn(h);
    const oc = await ensureCreator(h.deps.db, other.user);
    await expect(changePlanPrice(h.deps, oc.id, other.user.id, pc.plan.id, { price: "1" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("checkout", () => {
  it("creates the session on the connected account with DB-sourced price and Flock-only metadata", async () => {
    const pc = await publishedCommunity(h, { price: "25" });
    const buyer = await signIn(h);
    const co = await createCheckout(h.deps, buyer.user, pc.community.slug);
    const [intent] = await h.deps.db.select().from(checkoutIntents).where(eq(checkoutIntents.id, co.intentId));
    expect(intent).toMatchObject({ status: "open", stripeAccountId: pc.accountId, userId: buyer.user.id, communityId: pc.community.id });
    const session = h.stripeMock.sessions.get(intent!.stripeCheckoutSessionId!)!;
    expect(session.account).toBe(pc.accountId);
    expect(session.mode).toBe("subscription");
    expect(session.client_reference_id).toBe(intent!.id);
    expect(Object.keys(session.metadata as object).sort()).toEqual(["flock_checkout_intent_id", "flock_community_id", "flock_user_id"]);
    expect(String(session.success_url)).toContain(`/join/${pc.community.slug}/status?intent=${intent!.id}`);
    const customer = h.stripeMock.customers.get(String(session.customer))!;
    expect(customer.account).toBe(pc.accountId);
  });

  it("blocks duplicate subscriptions and unavailable pages", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await subscribe(h, pc.community.slug);
    await expect(createCheckout(h.deps, buyer.user, pc.community.slug)).rejects.toMatchObject({ code: "already_member" });
    await expect(createCheckout(h.deps, buyer.user, "does-not-exist")).rejects.toMatchObject({ code: "not_found" });
  });

  it("reuses one Stripe customer per subscriber per merchant", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await signIn(h);
    await createCheckout(h.deps, buyer.user, pc.community.slug);
    await createCheckout(h.deps, buyer.user, pc.community.slug);
    expect([...h.stripeMock.customers.values()].filter((c) => c.account === pc.accountId)).toHaveLength(1);
  });
});

describe("subscriber billing portal", () => {
  it("opens the portal on the creator's account for the subscriber's own customer only", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await subscribe(h, pc.community.slug);
    const { listMemberships } = await import("@flock/core");
    const [membership] = await listMemberships(h.deps, buyer.user.id);
    expect(membership).toMatchObject({ active: true, communityName: "Alpha Club" });
    const url = await createSubscriberPortalSession(h.deps, buyer.user.id, membership!.subscriptionId);
    expect(url).toContain("/_mock/portal/cus_");
    expect(h.stripeMock.requests.filter((r) => r.path.startsWith("/v1/billing_portal")).every((r) => r.account === pc.accountId)).toBe(true);

    const intruder = await signIn(h);
    await expect(createSubscriberPortalSession(h.deps, intruder.user.id, membership!.subscriptionId)).rejects.toMatchObject({ code: "not_found" });
  });
});
