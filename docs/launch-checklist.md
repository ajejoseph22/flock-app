# Launch checklist

Status key: ☐ not done · ☑ done and verified · ◐ done in code, needs live verification.

Readiness terms (used throughout the docs):

- **Implemented**: the code exists.
- **Tested**: automated tests pass against local mocks of Stripe and Telegram. This is not the same as testing against the real providers.
- **Integrated**: verified against the real Stripe test mode and a real Telegram bot.
- **Deployed**: running on Railway.
- **Launch-ready**: integrated, deployed, legally reviewed and monitored.

## 1. Accounts and decisions (owner: Ayo)

- ☐ Stripe platform account for Flock, with **Connect enabled**. Complete the platform profile (business type, support details, the industries creators will sell in).
- ☐ Confirm in the Stripe dashboard that **Accounts v2** is available on the platform account. If it isn't, see D-003 for the v1 fallback.
- ☐ Decide the Connect **dashboard and liability** setup. The code uses `dashboard: "full"`, with Stripe as fees and losses collector. Confirm this matches your Stripe agreement (D-003).
- ☐ Two bots from @BotFather: `flock_dev_bot` (development) and the production bot. Set name, description, about text and userpic. Note that bot usernames are permanent.
- ☐ Domain `useflock.co` registered, with DNS access.
- ☐ Support mailbox `support@useflock.co`.
- ☐ **Legal review** of `/terms` and `/privacy`. Both pages currently show a "Draft" notice on purpose. Remove `LegalDraftNote` only after review. Also decide entity, jurisdiction and governing law.
- ☐ Decide prohibited-content policy for creators, and how you'll review new communities (Stripe and Telegram both have restricted categories).

## 2. Stripe configuration (test mode first, then live)

- ☐ Create a **restricted key** for the platform with write access to:
  - Accounts v2 and account links
  - Products and Prices
  - Customers
  - Checkout Sessions
  - Subscriptions and Invoices (read)
  - Charges and Disputes (read)
  - Billing Portal

  Set it as `STRIPE_SECRET_KEY` in Railway, never in the repo.
- ☐ Webhook destinations. Copy each signing secret into the matching Railway variable.

  | Destination | URL | Events | Secret variable |
  |---|---|---|---|
  | **Connected accounts**, snapshot | `https://useflock.co/api/webhooks/stripe/connect` | `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.*`, `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.marked_uncollectible`, `invoice.voided`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.funds_withdrawn`, `charge.dispute.closed`, `account.updated` | `STRIPE_CONNECT_WEBHOOK_SECRET` |
  | **Your account**, snapshot | `https://useflock.co/api/webhooks/stripe/platform` | `checkout.session.completed`, `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed` | `STRIPE_PLATFORM_WEBHOOK_SECRET` |
  | **Accounts v2**, thin events | `https://useflock.co/api/webhooks/stripe/accounts` | `v2.core.account.updated`, `v2.core.account[requirements].updated`, `v2.core.account[configuration.merchant].capability_status_updated` | `STRIPE_ACCOUNTS_WEBHOOK_SECRET` |
- ☐ Branding: platform icon, colour, and statement descriptor guidance for creators.
- ☐ Check that Stripe Tax and receipts settings match what creators expect. Receipts are sent by the connected account.
- ◐ **Integration run in test mode.** Go through the full flow below with a real test-mode account and record the results in the PR:
  1. Onboard a creator account. Use Stripe's test onboarding data.
  2. Create a plan.
  3. Check out with card `4242 4242 4242 4242`.
  4. Fail a renewal with card `4000 0000 0000 0341`, using a test clock to advance time.
  5. Refund.
  6. Open a dispute with card `4000 0000 0000 0259`.
  7. Cancel from the Billing Portal.

  Watch `/admin` for failed webhooks throughout.

## 3. Telegram configuration

- ☐ Production bot token in `TELEGRAM_BOT_TOKEN`, its username in `TELEGRAM_BOT_USERNAME`, and a random `TELEGRAM_WEBHOOK_SECRET` (for example from `openssl rand -hex 32`).
- ☐ After the first deploy, run `pnpm telegram:set-webhook` with production env. It registers `https://useflock.co/api/webhooks/telegram` with the secret token and the allowed updates (`message`, `callback_query`, `my_chat_member`, `chat_member`, `chat_join_request`), and sets the bot commands. Check the result with `pnpm telegram:set-webhook --info`.
- ◐ **Integration run with a real bot:**
  1. Sign in from a phone and from desktop.
  2. Connect a private channel and a private supergroup.
  3. Remove the bot's "Ban users" right and check that the dashboard shows "needs attention".
  4. Pay and join with a second Telegram account.
  5. Forward the invite to a third account and check that it is declined.
  6. Cancel, then check that the bot removes the member when access ends.

## 4. Railway

- ☐ Project with three services: **Postgres** (managed; enable backups), **web**, and **worker**. Both web and worker build from the repo root. Set each service's "Config as code" path to `apps/web/railway.json` or `apps/worker/railway.json`.
- ☐ Variables on web and worker. Both need the same set, from `.env.example`. Set:
  - `FLOCK_ENV=production`
  - `APP_URL=https://useflock.co`
  - `TELEGRAM_MODE=webhook`
  - `DATABASE_URL` as a reference to the Railway Postgres variable

  Leave unset: `TELEGRAM_API_ROOT` and `STRIPE_API_*` (they are ignored in production anyway).
- ☐ Custom domain `useflock.co` on the **web** service. Add the DNS records Railway shows. HTTPS is provisioned automatically.
- ☐ The first deploy runs `pnpm db:migrate` as pre-deploy. Confirm in the deploy logs.
- ☐ Health checks: web `/api/health` (DB), worker `/health` (job loop and DB). Add an external uptime monitor on `https://useflock.co/api/health?worker=1`. It fails if no worker heartbeat in 2 minutes.
- ☐ `ADMIN_TELEGRAM_USER_IDS` set to your Telegram user ID, so you can open `/admin`.
- ☐ Log drain or alerts on `level>=50` (error) lines. Webhook signature failures log at warn.

## 5. Pre-launch verification

- ☑ `pnpm lint`, `pnpm typecheck`, `pnpm test` (unit + integration), `pnpm build`, `pnpm test:e2e` all pass locally. These runs use local Stripe and Telegram mocks.
- ☐ CI runs the same commands on every PR. No workflow is included yet. Add one with a Postgres service.
- ☐ Load sanity check: 50 concurrent checkouts against Stripe test mode. Check that webhook p95 ingest is under 300 ms and the job queue drains.
- ☐ Restore a database backup into a scratch database once.
- ☐ Rotate every secret that was ever pasted anywhere other than Railway.

## 6. Launch-day watch list

- `/admin`: failed webhook events, dead jobs, stale workers.
- Stripe dashboard → Developers → Webhooks: delivery failures for each destination.
- Telegram `getWebhookInfo`: `pending_update_count` and `last_error_message`.
- First real creator: walk them through onboarding live, and confirm their first member got in and appears in the dashboard.

## Known limitations at launch (by design)

- One community and one monthly plan per creator. There are no annual plans, trials or coupons.
- No member-facing emails. All notifications go through the Telegram bot.
- Flock's own paid plans are disabled (`PLATFORM_BILLING_ENABLED=false`). Pricing page shows them as "after early access".
- If the bot is blocked by a member, they still get the invite on the status page and `/account`. DM failures are not retried.
