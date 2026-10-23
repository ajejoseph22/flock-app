import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { STRIPE_WEBHOOK_DESTINATIONS, inspectWebhookDestinations } from "./webhook-destinations";

const APP = "https://app.useflock.com";
const spec = (key: string) => STRIPE_WEBHOOK_DESTINATIONS.find((s) => s.key === key)!;

function fakeStripe(endpoints: Partial<Stripe.WebhookEndpoint>[], destinations: Partial<Stripe.V2.Core.EventDestination>[]) {
  const iter = <T>(items: T[]) => ({
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  });
  return {
    webhookEndpoints: { list: () => iter(endpoints) },
    v2: { core: { eventDestinations: { list: () => iter(destinations) } } },
  } as unknown as Stripe;
}

describe("inspectWebhookDestinations", () => {
  it("reports every destination missing when nothing is configured", async () => {
    const res = await inspectWebhookDestinations(fakeStripe([], []), `${APP}/`);
    expect(res.map((r) => [r.spec.key, r.url, r.id])).toEqual([
      ["connect", `${APP}/api/webhooks/stripe/connect`, undefined],
      ["platform", `${APP}/api/webhooks/stripe/platform`, undefined],
      ["accounts", `${APP}/api/webhooks/stripe/accounts`, undefined],
    ]);
  });

  it("matches by URL and checks events, wildcards, status and API version", async () => {
    const res = await inspectWebhookDestinations(
      fakeStripe(
        [
          { id: "we_1", url: `${APP}/api/webhooks/stripe/connect`, status: "enabled", enabled_events: ["*"], api_version: Stripe.API_VERSION },
          { id: "we_2", url: `${APP}/api/webhooks/stripe/platform`, status: "disabled", enabled_events: ["customer.subscription.*", "invoice.paid"], api_version: "2025-03-31.basil" },
          { id: "we_x", url: "https://elsewhere.example/hook", status: "enabled", enabled_events: ["*"], api_version: null },
        ],
        [
          {
            id: "ed_1",
            event_payload: "thin",
            status: "enabled",
            enabled_events: spec("accounts").events.slice(0, 2),
            webhook_endpoint: { url: `${APP}/api/webhooks/stripe/accounts` } as Stripe.V2.Core.EventDestination.WebhookEndpoint,
          },
        ],
      ),
      APP,
    );
    const [connect, platform, accounts] = res;
    expect(connect).toMatchObject({ id: "we_1", enabled: true, missingEvents: [], apiVersionMismatch: undefined });
    expect(platform).toMatchObject({ id: "we_2", enabled: false, missingEvents: ["checkout.session.completed", "invoice.payment_failed"], apiVersionMismatch: "2025-03-31.basil" });
    expect(accounts).toMatchObject({ id: "ed_1", enabled: true, missingEvents: [spec("accounts").events[2]] });
  });
});
