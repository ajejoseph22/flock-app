import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { communities, creators, entitlements, jobs, telegramAccessGrants, webhookEvents } from "@flock/db";
import { runExpirySweep, runReconciliation, runRetention } from "@flock/core";
import { and, eq, sql } from "drizzle-orm";
import { createHarness, type Harness } from "./harness";
import { publishedCommunity, requestJoin, subscribe } from "./fixtures";

let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());
beforeEach(async () => h.reset());

describe("reconciliation", () => {
  it("recovers state after missed webhooks (worker/web outage) by re-syncing from Stripe", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await subscribe(h, pc.community.slug);
    await requestJoin(h, pc.chatId, buyer.telegramUserId);
    // Refund happens while our webhook endpoint is down: the event never arrives.
    const deliver = h.stripeMock.opts.deliver;
    h.stripeMock.opts.deliver = async () => undefined;
    await h.stripeMock.cancelAtPeriodEnd(buyer.stripeSubscriptionId);
    h.stripeMock.opts.deliver = deliver;
    await h.deps.db.execute(sql`update subscriptions set last_synced_at = now() - interval '2 hours'`);

    await runReconciliation(h.deps);
    await h.drain();
    const [ent] = await h.deps.db.select().from(entitlements).where(eq(entitlements.userId, buyer.user.id));
    expect(ent!.reason).toBe("canceled_until_period_end");
  });

  it("repairs grants that drifted from desired access", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await subscribe(h, pc.community.slug);
    // Simulate a lost access job: grant stuck as failed with nothing queued.
    await h.deps.db.update(telegramAccessGrants).set({ state: "failed" });
    await h.deps.db.delete(jobs);
    await runReconciliation(h.deps);
    await h.drain();
    const [g] = await h.deps.db.select().from(telegramAccessGrants).where(and(eq(telegramAccessGrants.userId, buyer.user.id), eq(telegramAccessGrants.communityId, pc.community.id)));
    expect(g!.state).toBe("invited");
  });

  it("detects members who left silently via getChatMember spot checks", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await subscribe(h, pc.community.slug);
    await requestJoin(h, pc.chatId, buyer.telegramUserId);
    h.tg.setMember(pc.chatId, buyer.telegramUserId, { status: "left" });
    const r = await runReconciliation(h.deps);
    expect(r.leftDetected).toBe(1);
    const [g] = await h.deps.db.select().from(telegramAccessGrants).where(eq(telegramAccessGrants.userId, buyer.user.id));
    expect(g!.state).toBe("left");
  });

  it("requeues webhook events that never got processed", async () => {
    await h.deps.db.insert(webhookEvents).values({ provider: "stripe_connect", externalId: "evt_stuck", type: "invoice.paid", payload: { id: "evt_stuck", type: "invoice.paid", account: "acct_none", data: { object: {} } }, receivedAt: new Date(Date.now() - 3_600_000) });
    const r = await runReconciliation(h.deps);
    expect(r.requeued).toBe(1);
    await h.drain();
    const [e] = await h.deps.db.select().from(webhookEvents);
    expect(e!.status).toBe("ignored");
  });

  it("never sends demo communities to Stripe or Telegram", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await subscribe(h, pc.community.slug);
    await h.deps.db.update(communities).set({ isDemo: true }).where(eq(communities.id, pc.community.id));
    await h.deps.db.update(creators).set({ isDemo: true });
    await h.deps.db.execute(sql`update subscriptions set last_synced_at = now() - interval '2 hours'`);
    await h.deps.db.execute(sql`update merchant_accounts set last_synced_at = now() - interval '2 days'`);
    await h.deps.db.execute(sql`update telegram_chats set last_verified_at = now() - interval '2 hours'`);
    await h.deps.db.update(entitlements).set({ accessEndsAt: new Date(h.clock.now.getTime() - 60_000) }).where(eq(entitlements.userId, buyer.user.id));
    await h.deps.db.delete(jobs);
    const stripeBefore = h.stripeMock.requests.length;
    const tgBefore = h.tg.calls.length;

    const r = await runReconciliation(h.deps);
    expect(r).toMatchObject({ subscriptions: 0, merchants: 0, chats: 0, grantRepairs: 0 });
    expect(await runExpirySweep(h.deps)).toMatchObject({ due: 0 });
    const queued = await h.deps.db.select().from(jobs);
    expect(queued.filter((j) => j.type.startsWith("stripe.") || j.type.startsWith("access."))).toHaveLength(0);
    expect(h.stripeMock.requests.length).toBe(stripeBefore);
    expect(h.tg.calls.length).toBe(tgBefore);
  });

  it("retention prunes old payloads but keeps recent and failed ones", async () => {
    const old = new Date(Date.now() - 40 * 86_400_000);
    await h.deps.db.insert(webhookEvents).values([
      { provider: "telegram", externalId: "1", type: "message", payload: {}, status: "processed", receivedAt: old },
      { provider: "telegram", externalId: "2", type: "message", payload: {}, status: "failed", receivedAt: old },
      { provider: "telegram", externalId: "3", type: "message", payload: {}, status: "processed" },
    ]);
    await runRetention(h.deps);
    expect((await h.deps.db.select().from(webhookEvents)).map((e) => e.externalId).sort()).toEqual(["2", "3"]);
  });
});
