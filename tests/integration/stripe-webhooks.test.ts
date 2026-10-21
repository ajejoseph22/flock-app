import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { entitlements, subscriptions, webhookEvents } from "@flock/db";
import { handleStripeWebhook } from "@flock/payments";
import { eq } from "drizzle-orm";
import { createHarness, type Harness } from "./harness";
import { publishedCommunity, signIn, subscribe } from "./fixtures";

let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());
beforeEach(async () => h.reset());

const call = (kind: "connect" | "platform" | "accounts", rawBody: string, signature: string | null) =>
  handleStripeWebhook(kind, { stripe: h.stripe, db: h.deps.db, config: h.deps.config, log: h.deps.log, rawBody, signature });

function signed(payload: object, secret = h.deps.config.stripe.connectWebhookSecret) {
  const raw = JSON.stringify(payload);
  return { raw, sig: h.stripe.webhooks.generateTestHeaderString({ payload: raw, secret }) };
}

describe("Stripe webhooks", () => {
  it("rejects missing or invalid signatures and wrong-secret events", async () => {
    const event = { id: "evt_x", object: "event", type: "customer.subscription.updated", account: "acct_x", livemode: false, data: { object: { id: "sub_x" } } };
    expect((await call("connect", JSON.stringify(event), null)).status).toBe(400);
    expect((await call("connect", JSON.stringify(event), "t=1,v1=deadbeef")).status).toBe(400);
    const wrong = signed(event, "whsec_wrong");
    expect((await call("connect", wrong.raw, wrong.sig)).status).toBe(400);
    // Tampered body with a valid signature for different content.
    const good = signed(event);
    expect((await call("connect", good.raw.replace("sub_x", "sub_y"), good.sig)).status).toBe(400);
    expect(await h.deps.db.select().from(webhookEvents)).toHaveLength(0);
  });

  it("separates connect and platform destinations", async () => {
    const connectEvent = { id: "evt_c", object: "event", type: "invoice.paid", account: "acct_x", livemode: false, data: { object: {} } };
    const p = signed(connectEvent, h.deps.config.stripe.platformWebhookSecret);
    expect((await call("platform", p.raw, p.sig)).status).toBe(400);
    const platformEvent = { id: "evt_p", object: "event", type: "invoice.paid", livemode: false, data: { object: {} } };
    const c = signed(platformEvent);
    expect((await call("connect", c.raw, c.sig)).status).toBe(400);
  });

  it("deduplicates repeated deliveries of the same event", async () => {
    const event = { id: "evt_dup", object: "event", type: "customer.subscription.updated", account: "acct_unknown", livemode: false, data: { object: { id: "sub_1" } } };
    const s = signed(event);
    const first = await call("connect", s.raw, s.sig);
    const second = await call("connect", s.raw, s.sig);
    expect(first).toMatchObject({ status: 200, body: { duplicate: false } });
    expect(second).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(await h.deps.db.select().from(webhookEvents)).toHaveLength(1);
    await h.drain();
    const [row] = await h.deps.db.select().from(webhookEvents);
    expect(row!.status).toBe("ignored"); // unknown connected account
  });

  it("out-of-order delivery converges to current Stripe state", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await signIn(h);
    // Capture events instead of delivering them, then replay newest-first.
    const captured: { target: "connect" | "platform" | "accounts"; raw: string; sig: string }[] = [];
    const deliver = h.stripeMock.opts.deliver;
    h.stripeMock.opts.deliver = async (target, raw, sig) => void captured.push({ target, raw, sig });
    const { createCheckout } = await import("@flock/core");
    const co = await createCheckout(h.deps, buyer.user, pc.community.slug);
    const paid = await h.stripeMock.payCheckout(new URL(co.url).pathname.split("/").at(-1)!);
    await h.stripeMock.cancelAtPeriodEnd(paid.subscriptionId);
    h.stripeMock.opts.deliver = deliver;

    for (const e of [...captured].reverse()) await call(e.target, e.raw, e.sig);
    await h.drain();
    const [sub] = await h.deps.db.select().from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, paid.subscriptionId));
    expect(sub).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
    const [ent] = await h.deps.db.select().from(entitlements).where(eq(entitlements.subscriptionId, sub!.id));
    expect(ent).toMatchObject({ status: "active", reason: "canceled_until_period_end" });

    // Replaying everything again changes nothing.
    for (const e of captured) await call(e.target, e.raw, e.sig);
    await h.drain();
    expect(await h.deps.db.select().from(subscriptions)).toHaveLength(1);
  });

  it("ignores subscriptions not created through Flock and cross-account intent spoofing", async () => {
    const pc = await publishedCommunity(h);
    const other = await publishedCommunity(h);
    const buyer = await subscribe(h, pc.community.slug);
    // An event on another creator's account that references this intent must not attach.
    const sub = h.stripeMock.subs.get(buyer.stripeSubscriptionId)!;
    h.stripeMock.subs.set("sub_spoof", { ...sub, id: "sub_spoof", account: other.accountId });
    const e = signed({ id: "evt_spoof", object: "event", type: "customer.subscription.updated", account: other.accountId, livemode: false, data: { object: { id: "sub_spoof" } } });
    await call("connect", e.raw, e.sig);
    await h.drain();
    expect(await h.deps.db.select().from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, "sub_spoof"))).toHaveLength(0);
  });

  it("thin v2 account events refresh merchant status", async () => {
    const pc = await publishedCommunity(h);
    h.stripeMock.accounts.get(pc.accountId)!.cardStatus = "restricted";
    await h.stripeMock.emitThin("v2.core.account[configuration.merchant].capability_status_updated", pc.accountId);
    await h.drain();
    const { merchantAccounts } = await import("@flock/db");
    const [m] = await h.deps.db.select().from(merchantAccounts).where(eq(merchantAccounts.stripeAccountId, pc.accountId));
    expect(m!.cardPaymentsStatus).toBe("restricted");
    const { createCheckout } = await import("@flock/core");
    const buyer = await signIn(h);
    await expect(createCheckout(h.deps, buyer.user, pc.community.slug)).rejects.toMatchObject({ code: "merchant_not_ready" });
  });
});
