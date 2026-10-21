import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { entitlements, subscriptions, telegramAccessGrants } from "@flock/db";
import { getCheckoutStatus, runExpirySweep } from "@flock/core";
import { and, eq } from "drizzle-orm";
import { createHarness, type Harness } from "./harness";
import { nextTelegramId, publishedCommunity, requestJoin, signIn, subscribe } from "./fixtures";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());
beforeEach(async () => h.reset());

async function grantOf(userId: string, communityId: string) {
  const [g] = await h.deps.db.select().from(telegramAccessGrants).where(and(eq(telegramAccessGrants.userId, userId), eq(telegramAccessGrants.communityId, communityId)));
  return g;
}
async function entitlementOf(userId: string, communityId: string) {
  const [e] = await h.deps.db.select().from(entitlements).where(and(eq(entitlements.userId, userId), eq(entitlements.communityId, communityId)));
  return e;
}

describe("payment → access lifecycle (mocked Stripe + Telegram)", () => {
  it("grants access only after Stripe-confirmed payment, then approves the paying user's join request", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await signIn(h, { firstName: "Buyer" });

    // Checkout created but not paid: the success redirect alone must not grant anything.
    const { createCheckout } = await import("@flock/core");
    const checkout = await createCheckout(h.deps, buyer.user, pc.community.slug);
    const before = await getCheckoutStatus(h.deps, buyer.user.id, checkout.intentId);
    expect(before?.view.state).toBe("confirming");
    expect(await entitlementOf(buyer.user.id, pc.community.id)).toBeUndefined();

    const sessionId = new URL(checkout.url).pathname.split("/").at(-1)!;
    await h.stripeMock.payCheckout(sessionId);
    await h.drain();

    const ent = await entitlementOf(buyer.user.id, pc.community.id);
    expect(ent).toMatchObject({ status: "active", reason: "active" });
    const grant = await grantOf(buyer.user.id, pc.community.id);
    expect(grant?.state).toBe("invited");
    expect(grant?.inviteLink).toMatch(/^https:\/\/t\.me\/\+mock/);
    // Invite link is a join-request link and was DM'd to the buyer.
    expect(h.tg.inviteLinks.get(grant!.inviteLink!)?.creates_join_request).toBe(true);
    expect(h.tg.messagesTo(buyer.telegramUserId).at(-1)?.reply_markup?.inline_keyboard[0]?.[0]?.url).toBe(grant!.inviteLink);

    const status = await getCheckoutStatus(h.deps, buyer.user.id, checkout.intentId);
    expect(status?.view).toMatchObject({ state: "invite_ready", inviteLink: grant!.inviteLink });

    await requestJoin(h, pc.chatId, buyer.telegramUserId);
    expect(h.tg.memberStatus(pc.chatId, buyer.telegramUserId)).toBe("member");
    expect((await grantOf(buyer.user.id, pc.community.id))?.state).toBe("member");
    expect(h.tg.inviteLinks.get(grant!.inviteLink!)?.revoked).toBe(true);
  });

  it("declines join requests from users without an entitlement (forwarded link)", async () => {
    const pc = await publishedCommunity(h);
    await subscribe(h, pc.community.slug);
    const stranger = nextTelegramId();
    await requestJoin(h, pc.chatId, stranger);
    expect(h.tg.callsOf("declineChatJoinRequest").map((c) => c.params.user_id)).toContain(stranger);
    expect(h.tg.memberStatus(pc.chatId, stranger)).toBe("left");
  });

  it("failed initial payment never grants access", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await subscribe(h, pc.community.slug, { fail: true });
    expect(await entitlementOf(buyer.user.id, pc.community.id)).toBeUndefined();
    expect(await grantOf(buyer.user.id, pc.community.id)).toBeUndefined();
    const status = await getCheckoutStatus(h.deps, buyer.user.id, buyer.intentId);
    expect(status?.view.state).toBe("payment_failed");
    // Grace never applies to an unpaid initial subscription, even after time passes.
    h.clock.advanceHours(1);
    await runExpirySweep(h.deps);
    await h.drain();
    expect(await entitlementOf(buyer.user.id, pc.community.id)).toBeUndefined();
  });

  it("renewal extends access without Telegram action", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await subscribe(h, pc.community.slug);
    await requestJoin(h, pc.chatId, buyer.telegramUserId);
    const first = await entitlementOf(buyer.user.id, pc.community.id);
    h.clock.advanceDays(30);
    await h.stripeMock.renew(buyer.stripeSubscriptionId);
    await h.drain();
    const after = await entitlementOf(buyer.user.id, pc.community.id);
    expect(after!.accessEndsAt!.getTime()).toBeGreaterThan(first!.accessEndsAt!.getTime() + 29 * 86_400_000);
    expect(h.tg.callsOf("banChatMember")).toHaveLength(0);
    expect(h.tg.memberStatus(pc.chatId, buyer.telegramUserId)).toBe("member");
  });

  it("failed renewal keeps access through the 48h grace, then removes; a later payment restores access", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await subscribe(h, pc.community.slug);
    await requestJoin(h, pc.chatId, buyer.telegramUserId);

    h.clock.advanceDays(30);
    await h.stripeMock.renew(buyer.stripeSubscriptionId, { fail: true });
    await h.drain();
    expect(await entitlementOf(buyer.user.id, pc.community.id)).toMatchObject({ status: "active", reason: "grace_period" });

    h.clock.advanceHours(47);
    await runExpirySweep(h.deps);
    await h.drain();
    expect(h.tg.memberStatus(pc.chatId, buyer.telegramUserId)).toBe("member");

    h.clock.advanceHours(2);
    await runExpirySweep(h.deps); // re-checks Stripe first (still past_due)
    await h.drain();
    expect(await entitlementOf(buyer.user.id, pc.community.id)).toMatchObject({ status: "ended", reason: "payment_failed" });
    expect(h.tg.memberStatus(pc.chatId, buyer.telegramUserId)).toBe("left"); // removed, but not left banned
    expect((await grantOf(buyer.user.id, pc.community.id))?.state).toBe("revoked");

    await h.stripeMock.recover(buyer.stripeSubscriptionId);
    await h.drain();
    expect(await entitlementOf(buyer.user.id, pc.community.id)).toMatchObject({ status: "active" });
    expect((await grantOf(buyer.user.id, pc.community.id))?.state).toBe("invited");
    await requestJoin(h, pc.chatId, buyer.telegramUserId);
    expect(h.tg.memberStatus(pc.chatId, buyer.telegramUserId)).toBe("member");
  });

  it("a missed renewal webhook does not remove a paying member (sweep re-checks Stripe)", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await subscribe(h, pc.community.slug);
    await requestJoin(h, pc.chatId, buyer.telegramUserId);
    // Renewal succeeds at Stripe but the webhook is lost.
    const deliver = h.stripeMock.opts.deliver;
    h.stripeMock.opts.deliver = async () => undefined;
    h.clock.advanceDays(30);
    await h.stripeMock.renew(buyer.stripeSubscriptionId);
    h.stripeMock.opts.deliver = deliver;
    h.clock.advanceHours(49); // past paid-through + grace of the *old* period
    await runExpirySweep(h.deps);
    await h.drain();
    expect(await entitlementOf(buyer.user.id, pc.community.id)).toMatchObject({ status: "active", reason: "active" });
    expect(h.tg.callsOf("banChatMember")).toHaveLength(0);
  });

  it("cancel at period end keeps access until paid-through, then removes", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await subscribe(h, pc.community.slug);
    await requestJoin(h, pc.chatId, buyer.telegramUserId);
    await h.stripeMock.cancelAtPeriodEnd(buyer.stripeSubscriptionId);
    await h.drain();
    expect(await entitlementOf(buyer.user.id, pc.community.id)).toMatchObject({ status: "active", reason: "canceled_until_period_end" });
    expect(h.tg.memberStatus(pc.chatId, buyer.telegramUserId)).toBe("member");

    h.clock.advanceDays(30);
    h.clock.advanceHours(1); // period end has passed
    await h.stripeMock.endSubscription(buyer.stripeSubscriptionId);
    await h.drain();
    await runExpirySweep(h.deps);
    await h.drain();
    expect(await entitlementOf(buyer.user.id, pc.community.id)).toMatchObject({ status: "ended" });
    expect(h.tg.memberStatus(pc.chatId, buyer.telegramUserId)).toBe("left");
  });

  it("full refund ends access immediately; partial refund doesn't", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await subscribe(h, pc.community.slug);
    await requestJoin(h, pc.chatId, buyer.telegramUserId);
    await h.stripeMock.refundLatest(buyer.stripeSubscriptionId, { partial: true });
    await h.drain();
    expect(await entitlementOf(buyer.user.id, pc.community.id)).toMatchObject({ status: "active" });
    await h.stripeMock.refundLatest(buyer.stripeSubscriptionId);
    await h.drain();
    expect(await entitlementOf(buyer.user.id, pc.community.id)).toMatchObject({ status: "ended", reason: "refunded" });
    expect(h.tg.memberStatus(pc.chatId, buyer.telegramUserId)).toBe("left");
  });

  it("an open dispute suspends access; a won dispute restores it", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await subscribe(h, pc.community.slug);
    await requestJoin(h, pc.chatId, buyer.telegramUserId);
    const dispute = await h.stripeMock.disputeLatest(buyer.stripeSubscriptionId);
    await h.drain();
    expect(await entitlementOf(buyer.user.id, pc.community.id)).toMatchObject({ status: "ended", reason: "disputed" });
    expect(h.tg.memberStatus(pc.chatId, buyer.telegramUserId)).toBe("left");
    await h.stripeMock.closeDispute(buyer.stripeSubscriptionId, dispute, "won");
    await h.drain();
    expect(await entitlementOf(buyer.user.id, pc.community.id)).toMatchObject({ status: "active" });
  });

  it("never removes chat admins or owners", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await subscribe(h, pc.community.slug);
    h.tg.setMember(pc.chatId, buyer.telegramUserId, { status: "administrator" });
    await h.stripeMock.refundLatest(buyer.stripeSubscriptionId);
    await h.drain();
    expect(h.tg.callsOf("banChatMember")).toHaveLength(0);
    expect(h.tg.memberStatus(pc.chatId, buyer.telegramUserId)).toBe("administrator");
    expect((await grantOf(buyer.user.id, pc.community.id))?.note).toBe("admin_not_removed");
  });

  it("keeps access while another valid entitlement exists for the same community", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await subscribe(h, pc.community.slug);
    await requestJoin(h, pc.chatId, buyer.telegramUserId);
    // Simulate a second, independently paid subscription (e.g. re-subscribed before the first ended).
    const [sub] = await h.deps.db.select().from(subscriptions).where(eq(subscriptions.userId, buyer.user.id));
    await h.deps.db.insert(subscriptions).values({ ...sub!, id: undefined, stripeSubscriptionId: "sub_other", checkoutIntentId: null } as never);
    const [other] = await h.deps.db.select().from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, "sub_other"));
    await h.deps.db.insert(entitlements).values({ subscriptionId: other!.id, userId: buyer.user.id, communityId: pc.community.id, status: "active", reason: "active", accessEndsAt: new Date(h.clock.now.getTime() + 20 * 86_400_000) });

    await h.stripeMock.refundLatest(buyer.stripeSubscriptionId);
    await h.drain();
    expect(await h.deps.db.select().from(entitlements).where(eq(entitlements.subscriptionId, sub!.id)).then((r) => r[0]?.status)).toBe("ended");
    expect(h.tg.callsOf("banChatMember")).toHaveLength(0);
    expect(h.tg.memberStatus(pc.chatId, buyer.telegramUserId)).toBe("member");
  });

  it("retries transient Telegram failures and honours retry_after", async () => {
    const pc = await publishedCommunity(h);
    h.tg.failNext("createChatInviteLink", 429, "Too Many Requests: retry after 3", 3);
    h.tg.failNext("createChatInviteLink", 502, "Bad Gateway");
    const buyer = await subscribe(h, pc.community.slug);
    expect((await grantOf(buyer.user.id, pc.community.id))?.state).toBe("failed");
    await h.drain({ includeDelayed: true });
    expect((await grantOf(buyer.user.id, pc.community.id))?.state).toBe("invited");
  });

  it("lost bot permissions flag the chat and recover after re-check", async () => {
    const pc = await publishedCommunity(h);
    h.tg.setMember(pc.chatId, h.deps.telegram.botId, { status: "member" });
    const buyer = await subscribe(h, pc.community.slug);
    expect((await grantOf(buyer.user.id, pc.community.id))?.state).toBe("failed");
    const { telegramChats } = await import("@flock/db");
    const [chat] = await h.deps.db.select().from(telegramChats).where(eq(telegramChats.communityId, pc.community.id));
    expect(chat?.status).toBe("needs_attention");
    h.tg.setMember(pc.chatId, h.deps.telegram.botId, { status: "administrator", can_invite_users: true, can_restrict_members: true });
    await h.drain({ includeDelayed: true });
    expect((await grantOf(buyer.user.id, pc.community.id))?.state).toBe("invited");
  });

  it("voluntary leave is tracked and not auto re-invited; /status re-issues a link", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await subscribe(h, pc.community.slug);
    await requestJoin(h, pc.chatId, buyer.telegramUserId);
    h.tg.setMember(pc.chatId, buyer.telegramUserId, { status: "left" });
    await h.telegram({
      chat_member: {
        chat: { id: pc.chatId, type: "channel", title: "Alpha" } as never,
        from: buyer.from,
        date: 0,
        old_chat_member: { status: "member", user: buyer.from },
        new_chat_member: { status: "left", user: buyer.from },
      },
    });
    await h.drain();
    expect((await grantOf(buyer.user.id, pc.community.id))?.state).toBe("left");
    const linksBefore = h.tg.callsOf("createChatInviteLink").length;
    await h.telegram({ message: { message_id: 9, date: 0, chat: { id: buyer.telegramUserId, type: "private", first_name: "Buyer" }, from: buyer.from, text: "/status" } });
    await h.drain();
    expect(h.tg.callsOf("createChatInviteLink").length).toBe(linksBefore + 1);
    expect((await grantOf(buyer.user.id, pc.community.id))?.state).toBe("invited");
  });
});
