import Stripe from "stripe";

/**
 * The three Stripe webhook destinations Flock needs, one per route under /api/webhooks/stripe.
 * Single source for `pnpm stripe:webhooks`, `deploy-check` and docs/launch-checklist.md.
 */
export interface WebhookDestinationSpec {
  key: "connect" | "platform" | "accounts";
  label: string;
  path: string;
  /** v1 snapshot endpoint (`connect` = events from connected accounts) or a v2 thin event destination. */
  kind: "snapshot" | "thin";
  connect: boolean;
  secretEnv: "STRIPE_CONNECT_WEBHOOK_SECRET" | "STRIPE_PLATFORM_WEBHOOK_SECRET" | "STRIPE_ACCOUNTS_WEBHOOK_SECRET";
  events: readonly string[];
}

export const STRIPE_WEBHOOK_DESTINATIONS: readonly WebhookDestinationSpec[] = [
  {
    key: "connect",
    label: "Flock connected accounts",
    path: "/api/webhooks/stripe/connect",
    kind: "snapshot",
    connect: true,
    secretEnv: "STRIPE_CONNECT_WEBHOOK_SECRET",
    events: [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "checkout.session.expired",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "customer.subscription.paused",
      "customer.subscription.resumed",
      "customer.subscription.pending_update_applied",
      "customer.subscription.pending_update_expired",
      "invoice.paid",
      "invoice.payment_succeeded",
      "invoice.payment_failed",
      "invoice.payment_action_required",
      "invoice.marked_uncollectible",
      "invoice.voided",
      "charge.refunded",
      "charge.dispute.created",
      "charge.dispute.funds_withdrawn",
      "charge.dispute.closed",
      "account.updated",
    ],
  },
  {
    key: "platform",
    label: "Flock platform",
    path: "/api/webhooks/stripe/platform",
    kind: "snapshot",
    connect: false,
    secretEnv: "STRIPE_PLATFORM_WEBHOOK_SECRET",
    events: [
      "checkout.session.completed",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "invoice.paid",
      "invoice.payment_failed",
    ],
  },
  {
    key: "accounts",
    label: "Flock Accounts v2",
    path: "/api/webhooks/stripe/accounts",
    kind: "thin",
    connect: false,
    secretEnv: "STRIPE_ACCOUNTS_WEBHOOK_SECRET",
    events: [
      "v2.core.account.updated",
      "v2.core.account[requirements].updated",
      "v2.core.account[configuration.merchant].capability_status_updated",
    ],
  },
];

export interface WebhookDestinationStatus {
  spec: WebhookDestinationSpec;
  url: string;
  /** Stripe id of the matching endpoint/destination, if one exists for this URL. */
  id?: string;
  enabled: boolean;
  missingEvents: string[];
  /** Snapshot endpoints only: the endpoint renders events with a different API version than the SDK pins. */
  apiVersionMismatch?: string;
}

const hasEvent = (enabled: string[], event: string) =>
  enabled.includes("*") || enabled.includes(event) || enabled.some((e) => e.endsWith(".*") && event.startsWith(e.slice(0, -1)));

/** Compare the destinations configured in Stripe with what Flock expects at `appUrl`. Read-only. */
export async function inspectWebhookDestinations(stripe: Stripe, appUrl: string): Promise<WebhookDestinationStatus[]> {
  const base = appUrl.replace(/\/$/, "");
  const endpoints: Stripe.WebhookEndpoint[] = [];
  for await (const e of stripe.webhookEndpoints.list({ limit: 100 })) endpoints.push(e);
  const destinations: Stripe.V2.Core.EventDestination[] = [];
  for await (const d of stripe.v2.core.eventDestinations.list({ include: ["webhook_endpoint.url"] })) destinations.push(d);

  return STRIPE_WEBHOOK_DESTINATIONS.map((spec) => {
    const url = base + spec.path;
    if (spec.kind === "snapshot") {
      const found = endpoints.find((e) => e.url === url);
      if (!found) return { spec, url, enabled: false, missingEvents: [...spec.events] };
      return {
        spec,
        url,
        id: found.id,
        enabled: found.status === "enabled",
        missingEvents: spec.events.filter((ev) => !hasEvent(found.enabled_events, ev)),
        apiVersionMismatch: found.api_version && found.api_version !== Stripe.API_VERSION ? found.api_version : undefined,
      };
    }
    const found = destinations.find((d) => d.webhook_endpoint?.url === url && d.event_payload === "thin");
    if (!found) return { spec, url, enabled: false, missingEvents: [...spec.events] };
    return { spec, url, id: found.id, enabled: found.status === "enabled", missingEvents: spec.events.filter((ev) => !hasEvent(found.enabled_events, ev)) };
  });
}

/**
 * Create one destination and return its signing secret (Stripe shows it only at creation).
 * Snapshot endpoints are pinned to the SDK's API version so event payloads match what the handlers parse.
 */
export async function createWebhookDestination(stripe: Stripe, spec: WebhookDestinationSpec, url: string): Promise<{ id: string; secret: string }> {
  if (spec.kind === "snapshot") {
    const created = await stripe.webhookEndpoints.create({
      url,
      enabled_events: [...spec.events] as Stripe.WebhookEndpointCreateParams.EnabledEvent[],
      connect: spec.connect,
      api_version: Stripe.API_VERSION as Stripe.WebhookEndpointCreateParams.ApiVersion,
      description: spec.label,
    });
    if (!created.secret) throw new Error(`Stripe returned no signing secret for ${url}`);
    return { id: created.id, secret: created.secret };
  }
  const created = await stripe.v2.core.eventDestinations.create({
    name: spec.label,
    type: "webhook_endpoint",
    event_payload: "thin",
    // v2 Account objects belong to the platform, so their events come from the platform itself.
    events_from: ["@self"],
    enabled_events: [...spec.events],
    webhook_endpoint: { url },
    include: ["webhook_endpoint.signing_secret"],
  });
  const secret = created.webhook_endpoint?.signing_secret;
  if (!secret) throw new Error(`Stripe returned no signing secret for ${url}`);
  return { id: created.id, secret };
}
