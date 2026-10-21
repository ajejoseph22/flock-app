import type { Update } from "@grammyjs/types";
import { claimJobs, completeJob, createLogger, failJob, parseConfig, runJob, type Deps } from "@flock/core";
import { createDb, type DbHandle } from "@flock/db";
import { createStripeClient, createStripeGateway, handleStripeWebhook } from "@flock/payments";
import { createTelegramGateway, handleTelegramWebhook } from "@flock/telegram";
import { sql } from "drizzle-orm";
import type Stripe from "stripe";
import { StripeMock } from "../mocks/stripe-mock";
import { TelegramMock } from "../mocks/telegram-mock";
import { BOT_ID, TEST_ENV } from "./env";

export interface Harness {
  deps: Deps;
  handle: DbHandle;
  tg: TelegramMock;
  stripeMock: StripeMock;
  stripe: Stripe;
  clock: { now: Date; advanceHours(h: number): void; advanceDays(d: number): void };
  /** Run due jobs until the queue is empty (or `maxRounds`). Returns failures. */
  drain(opts?: { includeDelayed?: boolean; maxRounds?: number }): Promise<{ type: string; error: string }[]>;
  telegram(update: Omit<Update, "update_id">): Promise<{ status: number }>;
  webhookResponses: { target: string; status: number; body: unknown }[];
  reset(): Promise<void>;
  close(): Promise<void>;
}

let updateSeq = 1;

export async function createHarness(): Promise<Harness> {
  const tg = new TelegramMock({ botId: BOT_ID, botUsername: TEST_ENV.TELEGRAM_BOT_USERNAME });
  await tg.start();
  const webhookResponses: Harness["webhookResponses"] = [];
  const clockRef = { now: new Date() };
  let deliver: (t: "connect" | "platform" | "accounts", raw: string, sig: string) => Promise<void> = async () => undefined;
  const stripeMock = new StripeMock({
    connectWebhookSecret: TEST_ENV.STRIPE_CONNECT_WEBHOOK_SECRET,
    platformWebhookSecret: TEST_ENV.STRIPE_PLATFORM_WEBHOOK_SECRET,
    accountsWebhookSecret: TEST_ENV.STRIPE_ACCOUNTS_WEBHOOK_SECRET,
    deliver: (t, raw, sig) => deliver(t, raw, sig),
    clock: () => Math.floor(clockRef.now.getTime() / 1000),
  });
  await stripeMock.start();

  const config = parseConfig({
    ...TEST_ENV,
    TELEGRAM_API_ROOT: tg.url,
    STRIPE_API_HOST: "127.0.0.1",
    STRIPE_API_PORT: String(stripeMock.port),
    STRIPE_API_PROTOCOL: "http",
  });
  const handle = createDb(config.databaseUrl, { max: 8 });
  const clock = {
    get now() {
      return clockRef.now;
    },
    set now(d: Date) {
      clockRef.now = d;
    },
    advanceHours(h: number) {
      clockRef.now = new Date(clockRef.now.getTime() + h * 3_600_000);
    },
    advanceDays(d: number) {
      this.advanceHours(d * 24);
    },
  };
  const stripe = createStripeClient({ secretKey: config.stripe.secretKey, apiOverride: config.stripe.apiOverride });
  const deps: Deps = {
    db: handle.db,
    config,
    log: createLogger({ level: "silent" }),
    now: () => clock.now,
    telegram: createTelegramGateway({ token: config.telegram.botToken, botId: BOT_ID, botUsername: config.telegram.botUsername, apiRoot: tg.url }),
    stripe: createStripeGateway(stripe),
  };

  deliver = async (target, rawBody, signature) => {
    const r = await handleStripeWebhook(target, { stripe, db: handle.db, config, log: deps.log, rawBody, signature });
    webhookResponses.push({ target, status: r.status, body: r.body });
  };

  const drain: Harness["drain"] = async (opts = {}) => {
    const failures: { type: string; error: string }[] = [];
    for (let round = 0; round < (opts.maxRounds ?? 50); round++) {
      if (opts.includeDelayed) await handle.db.execute(sql`update jobs set run_at = now() where status = 'queued'`);
      const jobs = await claimJobs(handle.db, "test-worker", 20);
      if (jobs.length === 0) break;
      for (const job of jobs) {
        try {
          await runJob(deps, job.type, job.payload);
          await completeJob(handle.db, job.id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push({ type: job.type, error: message });
          await failJob(handle.db, job, message);
        }
      }
    }
    return failures;
  };

  return {
    deps,
    handle,
    tg,
    stripeMock,
    stripe,
    clock,
    drain,
    webhookResponses,
    async telegram(update) {
      const r = await handleTelegramWebhook({
        db: handle.db,
        log: deps.log,
        expectedSecret: config.telegram.webhookSecret,
        secretHeader: config.telegram.webhookSecret,
        rawBody: JSON.stringify({ update_id: updateSeq++, ...update }),
      });
      return { status: r.status };
    },
    async reset() {
      tg.reset();
      stripeMock.reset();
      webhookResponses.length = 0;
      clock.now = new Date();
      await handle.db.execute(sql`
        truncate table jobs, webhook_events, audit_logs, analytics_events, rate_limits, worker_heartbeats,
          invoices, entitlements, telegram_access_grants, subscriptions, checkout_intents, subscriber_customers,
          plan_prices, membership_plans, chat_connection_requests, telegram_chats, communities, merchant_accounts,
          platform_subscriptions, creators, sessions, auth_challenges, users cascade
      `);
    },
    async close() {
      await handle.close();
      await tg.stop();
      await stripeMock.stop();
    },
  };
}
