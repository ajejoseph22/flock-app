import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDashboardStats, getMemberDetail, listMembers } from "@flock/core";
import { createHarness, type Harness } from "./harness";
import { publishedCommunity, requestJoin, signIn, subscribe } from "./fixtures";

let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());
beforeEach(async () => h.reset());

describe("creator reporting", () => {
  it("dashboard KPIs come from real records and start empty", async () => {
    const pc = await publishedCommunity(h, { price: "20" });
    let stats = await getDashboardStats(h.deps.db, pc.community.id, h.deps.now());
    expect(stats).toMatchObject({ activeMembers: 0, activeSubscriptions: 0, mrr: {} });

    const a = await subscribe(h, pc.community.slug);
    await subscribe(h, pc.community.slug);
    await requestJoin(h, pc.chatId, a.telegramUserId);
    await h.stripeMock.cancelAtPeriodEnd(a.stripeSubscriptionId);
    await h.drain();
    stats = await getDashboardStats(h.deps.db, pc.community.id, h.deps.now());
    expect(stats.activeMembers).toBe(2);
    expect(stats.activeSubscriptions).toBe(2);
    // D-017: the subscription set to cancel at period end still has access but no longer counts toward MRR.
    expect(stats.mrr).toEqual({ usd: 2000 });
    expect(stats.recentPayments).toHaveLength(2);
    expect(stats.recentCancellations).toHaveLength(1);
  });

  it("members table searches and sorts, scoped to the community; detail has a timeline", async () => {
    const pc = await publishedCommunity(h);
    const zed = await subscribe(h, pc.community.slug, { subscriber: await signIn(h, { firstName: "Zed", username: "zeddy" }) });
    await subscribe(h, pc.community.slug, { subscriber: await signIn(h, { firstName: "Amy", username: "amy" }) });
    await requestJoin(h, pc.chatId, zed.telegramUserId);

    expect((await listMembers(h.deps.db, pc.community.id, { sort: "name", dir: "asc" })).map((m) => m.name)).toEqual(["Amy", "Zed"]);
    expect((await listMembers(h.deps.db, pc.community.id, { q: "@zed" })).map((m) => m.name)).toEqual(["Zed"]);
    expect((await listMembers(h.deps.db, pc.community.id, { q: String(zed.telegramUserId) })).map((m) => m.name)).toEqual(["Zed"]);

    const detail = await getMemberDetail(h.deps.db, pc.community.id, zed.user.id);
    expect(detail!.grant!.state).toBe("member");
    const actions = detail!.timeline.map((t) => t.action);
    expect(actions).toEqual(expect.arrayContaining(["entitlement.activated", "access.invite_issued", "access.join_approved"]));
    expect(detail!.payments).toHaveLength(1);

    const other = await publishedCommunity(h);
    expect(await listMembers(h.deps.db, other.community.id)).toHaveLength(0);
    expect(await getMemberDetail(h.deps.db, other.community.id, zed.user.id)).toBeNull();
  });
});
