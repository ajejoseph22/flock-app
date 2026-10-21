/**
 * Local fake of the Stripe API surface Flock uses (MOCK — not a live provider).
 * Real stripe-node talks to it via host/port override. It signs and emits webhook events
 * the same way Stripe does (`Stripe-Signature`, t=…,v1=…), so webhook verification is exercised for real.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";
import { parseBracketForm } from "./form";

type Obj = Record<string, unknown>;
const DAY = 86_400;

export interface StripeMockOptions {
  connectWebhookSecret: string;
  platformWebhookSecret: string;
  accountsWebhookSecret: string;
  /** Deliver a signed event. Tests either POST it to the web app or call the handler in-process. */
  deliver?: (target: "connect" | "platform" | "accounts", rawBody: string, signature: string) => Promise<void>;
  /** Unix seconds; defaults to wall clock + clockOffset. Tests pass their controllable clock. */
  clock?: () => number;
}

interface Account {
  id: string;
  display_name: string;
  contact_email: string;
  cardStatus: "pending" | "active" | "restricted" | "rejected";
  requirements: { description: string; awaiting_action_from: string }[];
  metadata: Obj;
}

interface Sub {
  id: string;
  account: string;
  customer: string;
  price: string;
  status: string;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  ended_at: number | null;
  period_start: number;
  period_end: number;
  metadata: Obj;
  created: number;
  invoices: string[];
}

interface Invoice {
  id: string;
  account: string;
  subscription: string;
  status: "paid" | "open" | "void" | "uncollectible";
  amount: number;
  currency: string;
  period_start: number;
  period_end: number;
  paid_at: number | null;
  payment_intent: string;
  charge: string;
  amount_refunded: number;
}

export class StripeMock {
  readonly accounts = new Map<string, Account>();
  readonly products = new Map<string, Obj>();
  readonly prices = new Map<string, Obj & { unit_amount: number; currency: string; account: string }>();
  readonly customers = new Map<string, Obj & { account: string | null }>();
  readonly sessions = new Map<string, Obj & { account: string | null }>();
  readonly subs = new Map<string, Sub>();
  readonly invoices = new Map<string, Invoice>();
  readonly portalConfigs = new Map<string, Obj>();
  readonly idempotency = new Map<string, unknown>();
  readonly requests: { method: string; path: string; account: string | null }[] = [];
  readonly emitted: { type: string; account: string | null }[] = [];
  /** Seconds added to wall-clock time (simulated time advancement). */
  clockOffset = 0;
  private seq = 1;
  private server: Server | null = null;
  url = "";
  port = 0;
  private readonly signer = new Stripe("sk_test_mock_signer");

  constructor(readonly opts: StripeMockOptions) {}

  now() {
    return this.opts.clock ? this.opts.clock() : Math.floor(Date.now() / 1000) + this.clockOffset;
  }
  private id(prefix: string) {
    return `${prefix}_mock${(this.seq++).toString().padStart(6, "0")}`;
  }

  reset() {
    for (const m of [this.accounts, this.products, this.prices, this.customers, this.sessions, this.subs, this.invoices, this.portalConfigs, this.idempotency]) m.clear();
    this.requests.length = 0;
    this.emitted.length = 0;
    this.clockOffset = 0;
  }

  async start(port = 0) {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(port, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${this.port}`;
    return this.url;
  }
  async stop() {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  // ─── Object renderers ──────────────────────────────────────────────────────

  private renderAccount(a: Account) {
    return {
      id: a.id,
      object: "v2.core.account",
      applied_configurations: ["merchant"],
      contact_email: a.contact_email,
      created: new Date().toISOString(),
      dashboard: "full",
      display_name: a.display_name,
      livemode: false,
      metadata: a.metadata,
      identity: { country: "us", entity_type: "individual" },
      defaults: { currency: "usd", responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } },
      configuration: { merchant: { applied: true, capabilities: { card_payments: { status: a.cardStatus, status_details: [] } } } },
      requirements: {
        entries: a.requirements.map((r) => ({ ...r, errors: [], impact: { restricts_capabilities: [] }, minimum_deadline: { status: "currently_due" }, requested_reasons: [] })),
        summary: a.requirements.length ? { minimum_deadline: { status: "currently_due" } } : {},
      },
    };
  }

  private renderSub(s: Sub) {
    const price = this.prices.get(s.price)!;
    return {
      id: s.id,
      object: "subscription",
      customer: s.customer,
      status: s.status,
      cancel_at_period_end: s.cancel_at_period_end,
      cancel_at: s.cancel_at_period_end ? s.period_end : null,
      canceled_at: s.canceled_at,
      ended_at: s.ended_at,
      currency: price.currency,
      created: s.created,
      livemode: false,
      metadata: s.metadata,
      latest_invoice: s.invoices.at(-1) ?? null,
      items: {
        object: "list",
        data: [{ id: `si_${s.id}`, object: "subscription_item", current_period_start: s.period_start, current_period_end: s.period_end, quantity: 1, price: { id: price.id, object: "price", unit_amount: price.unit_amount, currency: price.currency } }],
        has_more: false,
      },
    };
  }

  private renderInvoice(i: Invoice) {
    return {
      id: i.id,
      object: "invoice",
      status: i.status,
      amount_paid: i.status === "paid" ? i.amount : 0,
      amount_due: i.amount,
      currency: i.currency,
      customer: this.subs.get(i.subscription)?.customer,
      parent: { type: "subscription_details", subscription_details: { subscription: i.subscription, metadata: {} } },
      lines: { object: "list", data: [{ id: `il_${i.id}`, object: "line_item", amount: i.amount, period: { start: i.period_start, end: i.period_end } }], has_more: false },
      status_transitions: { paid_at: i.paid_at, finalized_at: i.period_start },
      livemode: false,
    };
  }

  // ─── Webhook emission ──────────────────────────────────────────────────────

  async emit(target: "connect" | "platform", type: string, object: Obj, account: string | null) {
    const event = { id: this.id("evt"), object: "event", api_version: "2026-09-30.endive", created: this.now(), type, livemode: false, data: { object }, ...(account ? { account } : {}), pending_webhooks: 1, request: null };
    const raw = JSON.stringify(event);
    const secret = target === "connect" ? this.opts.connectWebhookSecret : this.opts.platformWebhookSecret;
    const signature = this.signer.webhooks.generateTestHeaderString({ payload: raw, secret });
    this.emitted.push({ type, account });
    await this.opts.deliver?.(target, raw, signature);
    return event;
  }

  async emitThin(type: string, accountId: string) {
    const event = { id: this.id("evt"), object: "v2.core.event", type, created: new Date().toISOString(), livemode: false, related_object: { id: accountId, type: "v2.core.account", url: `/v2/core/accounts/${accountId}` } };
    const raw = JSON.stringify(event);
    const signature = this.signer.webhooks.generateTestHeaderString({ payload: raw, secret: this.opts.accountsWebhookSecret });
    this.emitted.push({ type, account: accountId });
    await this.opts.deliver?.("accounts", raw, signature);
  }

  // ─── Simulated flows (what Stripe-hosted pages and test clocks would do) ──

  /** Hosted onboarding completed: card payments become active. */
  async completeOnboarding(accountId: string) {
    const a = this.accounts.get(accountId);
    if (!a) throw new Error("no account");
    a.cardStatus = "active";
    a.requirements = [];
    await this.emitThin("v2.core.account[configuration.merchant].capability_status_updated", accountId);
  }

  private newInvoice(s: Sub, status: Invoice["status"]): Invoice {
    const price = this.prices.get(s.price)!;
    const inv: Invoice = {
      id: this.id("in"),
      account: s.account,
      subscription: s.id,
      status,
      amount: price.unit_amount,
      currency: price.currency,
      period_start: s.period_start,
      period_end: s.period_end,
      paid_at: status === "paid" ? this.now() : null,
      payment_intent: this.id("pi"),
      charge: this.id("ch"),
      amount_refunded: 0,
    };
    this.invoices.set(inv.id, inv);
    s.invoices.push(inv.id);
    return inv;
  }

  /** Customer pays on the hosted Checkout page. */
  async payCheckout(sessionId: string, opts: { fail?: boolean } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("no session");
    const account = session.account as string;
    const lineItems = session.line_items as { price: string }[];
    const start = this.now();
    const sub: Sub = {
      id: this.id("sub"),
      account,
      customer: session.customer as string,
      price: lineItems[0]!.price,
      status: opts.fail ? "incomplete" : "active",
      cancel_at_period_end: false,
      canceled_at: null,
      ended_at: null,
      period_start: start,
      period_end: start + 30 * DAY,
      metadata: ((session.subscription_data as Obj | undefined)?.metadata as Obj) ?? {},
      created: start,
      invoices: [],
    };
    this.subs.set(sub.id, sub);
    const inv = this.newInvoice(sub, opts.fail ? "open" : "paid");
    session.status = opts.fail ? "open" : "complete";
    session.subscription = sub.id;
    session.payment_status = opts.fail ? "unpaid" : "paid";
    await this.emit("connect", "customer.subscription.created", this.renderSub(sub), account);
    if (!opts.fail) {
      await this.emit("connect", "invoice.paid", this.renderInvoice(inv), account);
      await this.emit("connect", "checkout.session.completed", this.renderSession(session), account);
    } else {
      await this.emit("connect", "invoice.payment_failed", this.renderInvoice(inv), account);
    }
    return { subscriptionId: sub.id, invoiceId: inv.id, successUrl: String(session.success_url) };
  }

  private renderSession(s: Obj) {
    const { account: _a, line_items: _l, ...rest } = s;
    return rest;
  }

  /** Advance simulated time by N days (like a test clock). */
  advanceDays(days: number) {
    this.clockOffset += days * DAY;
  }

  async renew(subId: string, opts: { fail?: boolean } = {}) {
    const s = this.subs.get(subId)!;
    s.period_start = s.period_end;
    s.period_end = s.period_start + 30 * DAY;
    const inv = this.newInvoice(s, opts.fail ? "open" : "paid");
    s.status = opts.fail ? "past_due" : "active";
    await this.emit("connect", opts.fail ? "invoice.payment_failed" : "invoice.paid", this.renderInvoice(inv), s.account);
    await this.emit("connect", "customer.subscription.updated", this.renderSub(s), s.account);
    return inv.id;
  }

  /** Retry of a failed invoice succeeds. */
  async recover(subId: string) {
    const s = this.subs.get(subId)!;
    const inv = this.invoices.get(s.invoices.at(-1)!)!;
    inv.status = "paid";
    inv.paid_at = this.now();
    s.status = "active";
    await this.emit("connect", "invoice.paid", this.renderInvoice(inv), s.account);
    await this.emit("connect", "customer.subscription.updated", this.renderSub(s), s.account);
  }

  async setStatus(subId: string, status: string) {
    const s = this.subs.get(subId)!;
    s.status = status;
    await this.emit("connect", "customer.subscription.updated", this.renderSub(s), s.account);
  }

  async cancelAtPeriodEnd(subId: string) {
    const s = this.subs.get(subId)!;
    s.cancel_at_period_end = true;
    await this.emit("connect", "customer.subscription.updated", this.renderSub(s), s.account);
  }

  /** Period end reached on a cancel-at-period-end subscription (or immediate cancel when `immediate`). */
  async endSubscription(subId: string, opts: { immediate?: boolean } = {}) {
    const s = this.subs.get(subId)!;
    s.status = "canceled";
    s.canceled_at = s.canceled_at ?? this.now();
    s.ended_at = opts.immediate ? this.now() : s.period_end;
    await this.emit("connect", "customer.subscription.deleted", this.renderSub(s), s.account);
  }

  async refundLatest(subId: string, opts: { partial?: boolean } = {}) {
    const s = this.subs.get(subId)!;
    const inv = this.invoices.get(s.invoices.at(-1)!)!;
    inv.amount_refunded = opts.partial ? Math.floor(inv.amount / 2) : inv.amount;
    await this.emit("connect", "charge.refunded", this.renderCharge(inv), s.account);
  }

  async disputeLatest(subId: string) {
    const s = this.subs.get(subId)!;
    const inv = this.invoices.get(s.invoices.at(-1)!)!;
    const disputeId = this.id("dp");
    await this.emit("connect", "charge.dispute.created", { id: disputeId, object: "dispute", charge: inv.charge, status: "needs_response", amount: inv.amount }, s.account);
    return disputeId;
  }

  async closeDispute(subId: string, disputeId: string, status: "won" | "lost") {
    const s = this.subs.get(subId)!;
    const inv = this.invoices.get(s.invoices.at(-1)!)!;
    await this.emit("connect", "charge.dispute.closed", { id: disputeId, object: "dispute", charge: inv.charge, status, amount: inv.amount }, s.account);
  }

  private renderCharge(inv: Invoice) {
    return { id: inv.charge, object: "charge", amount: inv.amount, amount_refunded: inv.amount_refunded, refunded: inv.amount_refunded >= inv.amount, payment_intent: inv.payment_intent, currency: inv.currency };
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", this.url);
    const method = req.method ?? "GET";
    const account = (req.headers["stripe-account"] as string | undefined) ?? null;
    const idem = req.headers["idempotency-key"] as string | undefined;
    this.requests.push({ method, path: url.pathname, account });

    try {
      if (url.pathname.startsWith("/_mock/")) return await this.control(method, url, raw, res);
      const isJson = (req.headers["content-type"] ?? "").includes("json");
      const body: Obj = method === "GET" ? parseBracketForm(url.search.slice(1)) : isJson && raw ? (JSON.parse(raw) as Obj) : parseBracketForm(raw);
      const cacheKey = idem ? `${account ?? "platform"}:${method}:${url.pathname}:${idem}` : null;
      if (cacheKey && this.idempotency.has(cacheKey)) return send(res, 200, this.idempotency.get(cacheKey));
      const result = this.route(method, url.pathname, body, account);
      if (result === undefined) return send(res, 404, { error: { type: "invalid_request_error", message: `Mock has no route ${method} ${url.pathname}` } });
      if (cacheKey) this.idempotency.set(cacheKey, result);
      send(res, 200, result);
    } catch (err) {
      const e = err as { status?: number; message: string };
      send(res, e.status ?? 400, { error: { type: "invalid_request_error", message: e.message } });
    }
  }

  private notFound(what: string): never {
    throw Object.assign(new Error(`No such ${what}`), { status: 404 });
  }

  private requireAccount(account: string | null) {
    if (!account) return null;
    if (!this.accounts.has(account)) throw Object.assign(new Error(`No such account: ${account}`), { status: 403 });
    return account;
  }

  private route(method: string, path: string, body: Obj, account: string | null): unknown {
    const acct = this.requireAccount(account);
    const seg = path.split("/").filter(Boolean);
    const key = `${method} /${seg.slice(0, 2).join("/")}`;

    // v2 accounts
    if (method === "POST" && path === "/v2/core/accounts") {
      const a: Account = {
        id: this.id("acct"),
        display_name: String(body.display_name ?? ""),
        contact_email: String(body.contact_email ?? ""),
        cardStatus: "pending",
        requirements: [{ description: "Provide business details", awaiting_action_from: "user" }],
        metadata: (body.metadata as Obj) ?? {},
      };
      this.accounts.set(a.id, a);
      return this.renderAccount(a);
    }
    if (method === "GET" && seg[0] === "v2" && seg[2] === "accounts" && seg[3]) {
      const a = this.accounts.get(seg[3]) ?? this.notFound("account");
      return this.renderAccount(a);
    }
    if (method === "POST" && path === "/v2/core/account_links") {
      const accountId = String(body.account);
      if (!this.accounts.has(accountId)) this.notFound("account");
      const onboarding = (body.use_case as Obj).account_onboarding as Obj;
      return {
        object: "v2.core.account_link",
        account: accountId,
        created: new Date().toISOString(),
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        livemode: false,
        url: `${this.url}/_mock/onboarding/${accountId}?n=${this.seq++}&return_url=${encodeURIComponent(String(onboarding.return_url))}`,
        use_case: body.use_case,
      };
    }

    switch (key) {
      case "POST /v1/products": {
        if (seg[2]) {
          const p = this.products.get(seg[2]) ?? this.notFound("product");
          Object.assign(p, body);
          return p;
        }
        const p = { id: this.id("prod"), object: "product", ...body, account: acct };
        this.products.set(p.id, p);
        return p;
      }
      case "POST /v1/prices": {
        if (seg[2]) {
          const p = this.prices.get(seg[2]) ?? this.notFound("price");
          if (body.active !== undefined) p.active = body.active === "true";
          return p;
        }
        const p = { id: this.id("price"), object: "price", product: body.product, unit_amount: Number(body.unit_amount), currency: String(body.currency), recurring: body.recurring, active: true, metadata: body.metadata ?? {}, account: acct ?? "" };
        this.prices.set(p.id, p);
        return p;
      }
      case "POST /v1/customers": {
        const c = { id: this.id("cus"), object: "customer", name: body.name, email: body.email ?? null, metadata: body.metadata ?? {}, account: acct };
        this.customers.set(c.id, c);
        return c;
      }
      case "POST /v1/checkout": {
        const items = body.line_items as { price: string }[];
        const price = this.prices.get(items[0]!.price);
        if (!price || (price.account || null) !== (acct ?? null)) this.notFound("price");
        const s = {
          id: this.id("cs"),
          object: "checkout.session",
          mode: body.mode,
          status: "open",
          payment_status: "unpaid",
          customer: body.customer,
          client_reference_id: body.client_reference_id ?? null,
          metadata: body.metadata ?? {},
          subscription_data: body.subscription_data,
          success_url: body.success_url,
          cancel_url: body.cancel_url,
          subscription: null,
          line_items: items,
          account: acct,
          url: "",
        };
        s.url = `${this.url}/_mock/checkout/${s.id}`;
        this.sessions.set(s.id, s);
        return this.renderSession(s);
      }
      case "GET /v1/checkout": {
        const s = this.sessions.get(seg[3] ?? "") ?? this.notFound("checkout session");
        return this.renderSession(s);
      }
      case "GET /v1/subscriptions": {
        const s = this.subs.get(seg[2] ?? "");
        if (!s || (s.account !== acct && acct !== null)) this.notFound("subscription");
        return this.renderSub(s);
      }
      case "GET /v1/invoices": {
        if (seg[2]) {
          const i = this.invoices.get(seg[2]) ?? this.notFound("invoice");
          return this.renderInvoice(i);
        }
        const subId = String(body.subscription);
        const list = [...this.invoices.values()].filter((i) => i.subscription === subId && i.account === acct).reverse().slice(0, Number(body.limit ?? 10));
        return { object: "list", data: list.map((i) => this.renderInvoice(i)), has_more: false, url: "/v1/invoices" };
      }
      case "GET /v1/invoice_payments": {
        const pi = String((body.payment as Obj | undefined)?.payment_intent ?? "");
        const inv = [...this.invoices.values()].find((i) => i.payment_intent === pi && i.account === acct);
        return { object: "list", data: inv ? [{ id: this.id("inpay"), object: "invoice_payment", invoice: inv.id, payment: { type: "payment_intent", payment_intent: pi } }] : [], has_more: false };
      }
      case "GET /v1/charges": {
        const inv = [...this.invoices.values()].find((i) => i.charge === seg[2] && i.account === acct) ?? this.notFound("charge");
        return this.renderCharge(inv);
      }
      case "POST /v1/billing_portal": {
        if (seg[2] === "configurations") {
          const c = { id: this.id("bpc"), object: "billing_portal.configuration", ...body, account: acct };
          this.portalConfigs.set(c.id, c);
          return c;
        }
        if (seg[2] === "sessions") {
          return { id: this.id("bps"), object: "billing_portal.session", customer: body.customer, url: `${this.url}/_mock/portal/${String(body.customer)}?return_url=${encodeURIComponent(String(body.return_url))}`, return_url: body.return_url };
        }
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private async control(method: string, url: URL, raw: string, res: ServerResponse) {
    const seg = url.pathname.split("/").filter(Boolean); // _mock, kind, id, action
    const body = raw && raw.startsWith("{") ? (JSON.parse(raw) as Obj) : {};
    if (seg[1] === "onboarding" && seg[2]) {
      // Simulated Stripe-hosted onboarding: completes immediately and returns to the platform.
      await this.completeOnboarding(seg[2]);
      res.writeHead(302, { location: url.searchParams.get("return_url") ?? "/" }).end();
      return;
    }
    if (seg[1] === "checkout" && seg[2] && method === "GET") {
      const s = this.sessions.get(seg[2]);
      if (!s) return send(res, 404, { error: "no session" });
      const price = this.prices.get((s.line_items as { price: string }[])[0]!.price)!;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Mock Stripe Checkout</title><body style="font-family:sans-serif;padding:40px">
        <p><strong>MOCK Stripe Checkout</strong> (test harness, not Stripe)</p>
        <p>Amount: ${price.unit_amount} ${price.currency} / month</p>
        <form method="post" action="/_mock/checkout/${s.id}/pay"><button type="submit">Pay</button></form>
        <p><a href="${String(s.cancel_url)}">Cancel</a></p></body>`);
      return;
    }
    if (seg[1] === "checkout" && seg[2] && seg[3] === "pay") {
      const r = await this.payCheckout(seg[2], { fail: url.searchParams.get("fail") === "1" });
      res.writeHead(302, { location: r.successUrl }).end();
      return;
    }
    if (seg[1] === "portal") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Mock Billing Portal</title><p>MOCK billing portal for ${seg[2]}</p><a href="${url.searchParams.get("return_url")}">Return</a>`);
      return;
    }
    if (seg[1] === "subscriptions" && seg[2]) {
      const subId = seg[2];
      switch (seg[3]) {
        case "renew":
          return send(res, 200, { invoiceId: await this.renew(subId, { fail: body.fail === true }) });
        case "recover":
          await this.recover(subId);
          return send(res, 200, { ok: true });
        case "cancel-at-period-end":
          await this.cancelAtPeriodEnd(subId);
          return send(res, 200, { ok: true });
        case "end":
          await this.endSubscription(subId, { immediate: body.immediate === true });
          return send(res, 200, { ok: true });
        case "refund":
          await this.refundLatest(subId, { partial: body.partial === true });
          return send(res, 200, { ok: true });
        case "expire-period": {
          // Simulated time advancement: shift this subscription's periods into the past.
          const s = this.subs.get(subId)!;
          const shift = s.period_end - this.now() + 3 * DAY;
          s.period_start -= shift;
          s.period_end -= shift;
          for (const id of s.invoices) {
            const inv = this.invoices.get(id)!;
            inv.period_start -= shift;
            inv.period_end -= shift;
          }
          return send(res, 200, { ok: true });
        }
      }
    }
    if (seg[1] === "state") {
      return send(res, 200, {
        accounts: [...this.accounts.values()].map((a) => ({ id: a.id, cardStatus: a.cardStatus })),
        subscriptions: [...this.subs.values()].map((s) => ({ id: s.id, status: s.status, account: s.account })),
        sessions: [...this.sessions.values()].map((s) => ({ id: s.id, status: s.status, subscription: s.subscription, success_url: s.success_url, account: s.account })),
        emitted: this.emitted,
      });
    }
    if (seg[1] === "reset") {
      this.reset();
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "unknown control" });
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "request-id": `req_mock_${Date.now()}` });
  res.end(JSON.stringify(body));
}
