import {
  StripeGatewayError,
  type CheckoutSessionSnapshot,
  type InvoiceSnapshot,
  type MerchantAccountSnapshot,
  type StripeGateway,
  type SubscriptionSnapshot,
} from "@flock/core";
import Stripe from "stripe";

const toDate = (unix: number | null | undefined) => (typeof unix === "number" ? new Date(unix * 1000) : null);
const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : (v?.id ?? null));

/** Normalise Stripe SDK errors so services can tell retryable from permanent failures. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      const kind =
        err instanceof Stripe.errors.StripeRateLimitError
          ? "rate_limited"
          : err instanceof Stripe.errors.StripeConnectionError || err instanceof Stripe.errors.StripeAPIError
            ? "transient"
            : err instanceof Stripe.errors.StripePermissionError || err instanceof Stripe.errors.StripeAuthenticationError
              ? "permission"
              : err instanceof Stripe.errors.StripeCardError
                ? "card"
                : err.statusCode === 404
                  ? "not_found"
                  : (err.statusCode ?? 0) >= 500
                    ? "transient"
                    : "invalid_request";
      throw new StripeGatewayError(kind, err.message, err.code);
    }
    throw err;
  }
}

export function mapV2Account(a: Stripe.V2.Core.Account): MerchantAccountSnapshot {
  const entries = a.requirements?.entries ?? [];
  return {
    id: a.id,
    livemode: a.livemode,
    displayName: a.display_name ?? null,
    country: a.identity?.country ?? null,
    defaultCurrency: a.defaults?.currency ?? null,
    cardPaymentsStatus: a.configuration?.merchant?.capabilities?.card_payments?.status ?? null,
    requirementsStatus: a.requirements?.summary?.minimum_deadline?.status ?? null,
    requirements: entries.map((e) => ({
      description: e.description,
      awaitingActionFrom: e.awaiting_action_from,
      deadlineStatus: e.minimum_deadline?.status ?? null,
    })),
  };
}

export function mapSubscription(s: Stripe.Subscription): SubscriptionSnapshot {
  const item = s.items.data[0];
  return {
    id: s.id,
    customerId: idOf(s.customer) ?? "",
    status: s.status,
    cancelAtPeriodEnd: s.cancel_at_period_end,
    cancelAt: toDate(s.cancel_at),
    canceledAt: toDate(s.canceled_at),
    endedAt: toDate(s.ended_at),
    currentPeriodStart: toDate(item?.current_period_start),
    currentPeriodEnd: toDate(item?.current_period_end),
    priceId: item?.price.id ?? null,
    amountMinor: (item?.price.unit_amount ?? 0) * (item?.quantity ?? 1),
    currency: s.currency,
    metadata: s.metadata ?? {},
    created: new Date(s.created * 1000),
    livemode: s.livemode,
  };
}

export function mapInvoice(i: Stripe.Invoice): InvoiceSnapshot {
  let periodEnd: number | null = null;
  for (const line of i.lines?.data ?? []) {
    if (line.period?.end && (periodEnd === null || line.period.end > periodEnd)) periodEnd = line.period.end;
  }
  return {
    id: i.id ?? "",
    status: i.status ?? "draft",
    subscriptionId: idOf(i.parent?.subscription_details?.subscription),
    periodEnd: toDate(periodEnd),
    amountPaid: i.amount_paid,
    currency: i.currency,
    paidAt: toDate(i.status_transitions?.paid_at),
  };
}

function mapSession(s: Stripe.Checkout.Session): CheckoutSessionSnapshot {
  return {
    id: s.id,
    url: s.url ?? null,
    status: s.status ?? "open",
    subscriptionId: idOf(s.subscription),
    customerId: idOf(s.customer),
    clientReferenceId: s.client_reference_id ?? null,
    metadata: s.metadata ?? {},
  };
}

const ACCOUNT_INCLUDE: Stripe.V2.Core.AccountRetrieveParams.Include[] = ["configuration.merchant", "requirements", "defaults", "identity"];

export function createStripeGateway(stripe: Stripe): StripeGateway {
  const on = (stripeAccount: string, idempotencyKey?: string): Stripe.RequestOptions => ({ stripeAccount, ...(idempotencyKey ? { idempotencyKey } : {}) });

  return {
    createMerchantAccount: (p, idempotencyKey) =>
      call(async () =>
        mapV2Account(
          await stripe.v2.core.accounts.create(
            {
              display_name: p.displayName,
              contact_email: p.contactEmail,
              dashboard: "full",
              defaults: {
                currency: p.defaultCurrency,
                // Stripe collects fees from and is liable for negative balances of the creator (D-004).
                responsibilities: { fees_collector: "stripe", losses_collector: "stripe" },
              },
              configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
              include: ACCOUNT_INCLUDE,
              metadata: p.metadata,
            },
            { idempotencyKey },
          ),
        ),
      ),
    retrieveMerchantAccount: (accountId) => call(async () => mapV2Account(await stripe.v2.core.accounts.retrieve(accountId, { include: ACCOUNT_INCLUDE }))),
    createOnboardingLink: (accountId, urls) =>
      call(async () => {
        const link = await stripe.v2.core.accountLinks.create({
          account: accountId,
          use_case: {
            type: "account_onboarding",
            account_onboarding: { refresh_url: urls.refreshUrl, return_url: urls.returnUrl, collection_options: { fields: "eventually_due" } },
          },
        });
        return { url: link.url };
      }),

    createProduct: (accountId, p, key) => call(async () => ({ id: (await stripe.products.create({ name: p.name, description: p.description, metadata: p.metadata }, on(accountId, key))).id })),
    updateProduct: (accountId, productId, p) => call(async () => void (await stripe.products.update(productId, { name: p.name, description: p.description }, on(accountId)))),
    createMonthlyPrice: (accountId, p, key) =>
      call(async () => ({
        id: (
          await stripe.prices.create(
            { product: p.productId, unit_amount: p.amountMinor, currency: p.currency, recurring: { interval: "month", interval_count: 1 }, metadata: p.metadata },
            on(accountId, key),
          )
        ).id,
      })),
    setPriceActive: (accountId, priceId, active) => call(async () => void (await stripe.prices.update(priceId, { active }, on(accountId)))),

    createCustomer: (accountId, p, key) => call(async () => ({ id: (await stripe.customers.create({ name: p.name, metadata: p.metadata }, on(accountId, key))).id })),
    createSubscriptionCheckout: (accountId, p, key) =>
      call(async () =>
        mapSession(
          await stripe.checkout.sessions.create(
            {
              mode: "subscription",
              customer: p.customerId,
              line_items: [{ price: p.priceId, quantity: 1 }],
              client_reference_id: p.clientReferenceId,
              metadata: p.metadata,
              subscription_data: { metadata: p.metadata },
              success_url: p.successUrl,
              cancel_url: p.cancelUrl,
            },
            on(accountId, key),
          ),
        ),
      ),
    retrieveCheckoutSession: (accountId, sessionId) => call(async () => mapSession(await stripe.checkout.sessions.retrieve(sessionId, {}, on(accountId)))),
    retrieveSubscription: (accountId, id) => call(async () => mapSubscription(await stripe.subscriptions.retrieve(id, {}, on(accountId)))),
    listSubscriptionInvoices: (accountId, subscriptionId) =>
      call(async () => (await stripe.invoices.list({ subscription: subscriptionId, limit: 12 }, on(accountId))).data.map(mapInvoice)),
    retrieveInvoice: (accountId, id) => call(async () => mapInvoice(await stripe.invoices.retrieve(id, {}, on(accountId)))),
    findInvoiceIdForPaymentIntent: (accountId, paymentIntentId) =>
      call(async () => {
        const list = await stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: paymentIntentId }, limit: 1 }, on(accountId));
        return idOf(list.data[0]?.invoice);
      }),
    retrieveChargePaymentIntent: (accountId, chargeId) =>
      call(async () => {
        const c = await stripe.charges.retrieve(chargeId, {}, on(accountId));
        return { paymentIntentId: idOf(c.payment_intent), amount: c.amount, amountRefunded: c.amount_refunded };
      }),
    createPortalConfiguration: (accountId, p) =>
      call(async () => ({
        id: (
          await stripe.billingPortal.configurations.create(
            {
              business_profile: { headline: p.headline.slice(0, 60) },
              default_return_url: p.returnUrl,
              features: {
                invoice_history: { enabled: true },
                payment_method_update: { enabled: true },
                subscription_cancel: { enabled: true, mode: "at_period_end", cancellation_reason: { enabled: true, options: ["too_expensive", "unused", "other"] } },
              },
            },
            on(accountId, `flock-portal-config:${accountId}`),
          )
        ).id,
      })),
    createPortalSession: (accountId, p) =>
      call(async () => ({ url: (await stripe.billingPortal.sessions.create({ customer: p.customerId, return_url: p.returnUrl, configuration: p.configurationId }, on(accountId))).url })),

    createPlatformCustomer: (p, key) =>
      call(async () => ({ id: (await stripe.customers.create({ name: p.name, ...(p.email ? { email: p.email } : {}), metadata: p.metadata }, { idempotencyKey: key })).id })),
    createPlatformCheckout: (p, key) =>
      call(async () =>
        mapSession(
          await stripe.checkout.sessions.create(
            {
              mode: "subscription",
              customer: p.customerId,
              line_items: [{ price: p.priceId, quantity: 1 }],
              client_reference_id: p.clientReferenceId,
              metadata: p.metadata,
              subscription_data: { metadata: p.metadata },
              success_url: p.successUrl,
              cancel_url: p.cancelUrl,
            },
            { idempotencyKey: key },
          ),
        ),
      ),
    retrievePlatformSubscription: (id) => call(async () => mapSubscription(await stripe.subscriptions.retrieve(id))),
    createPlatformPortalSession: (p) => call(async () => ({ url: (await stripe.billingPortal.sessions.create({ customer: p.customerId, return_url: p.returnUrl })).url })),
  };
}
