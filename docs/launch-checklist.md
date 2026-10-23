# Launch checklist

Status key: ☐ not done · ☑ done and verified · ◐ done in code, needs live verification.

Readiness terms (used throughout the docs):

- **Implemented**: the code exists.
- **Tested**: automated tests pass against local mocks of Stripe and Telegram. This is not the same as testing against the real providers.
- **Integrated**: verified against the real Stripe test mode and a real Telegram bot.
- **Deployed**: running on the Hetzner server via Coolify.
- **Launch-ready**: integrated, deployed, legally reviewed and monitored.

## 1. Accounts and decisions (owner: Ayo)

- ☐ Stripe platform account for Flock, with **Connect enabled**. Complete the platform profile (business type, support details, the industries creators will sell in).
- ☐ Confirm in the Stripe dashboard that **Accounts v2** is available on the platform account. If it isn't, see D-003 for the v1 fallback.
- ☐ Decide the Connect **dashboard and liability** setup. The code uses `dashboard: "full"`, with Stripe as fees and losses collector. Confirm this matches your Stripe agreement (D-003).
- ☐ Two bots from @BotFather: `flock_dev_bot` (development) and the production bot. Set name, description, about text and userpic. Note that bot usernames are permanent.
- ☐ Domain `useflock.com` with DNS access. The app runs on `app.useflock.com`; the apex and `www` stay on Vercel for the marketing site.
- ☐ Support mailbox `support@useflock.com`.
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

  Set it as `STRIPE_SECRET_KEY` in Coolify, never in the repo.
- ☐ Webhook destinations. `pnpm stripe:webhooks --app-url https://app.useflock.com --create` creates all three (event lists in `packages/payments/src/webhook-destinations.ts`) and prints each signing secret once. Copy each into the matching Coolify variable.

  | Destination | URL | Events | Secret variable |
  |---|---|---|---|
  | **Connected accounts**, snapshot | `https://app.useflock.com/api/webhooks/stripe/connect` | `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.*`, `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.marked_uncollectible`, `invoice.voided`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.funds_withdrawn`, `charge.dispute.closed`, `account.updated` | `STRIPE_CONNECT_WEBHOOK_SECRET` |
  | **Your account**, snapshot | `https://app.useflock.com/api/webhooks/stripe/platform` | `checkout.session.completed`, `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed` | `STRIPE_PLATFORM_WEBHOOK_SECRET` |
  | **Accounts v2**, thin events | `https://app.useflock.com/api/webhooks/stripe/accounts` | `v2.core.account.updated`, `v2.core.account[requirements].updated`, `v2.core.account[configuration.merchant].capability_status_updated` | `STRIPE_ACCOUNTS_WEBHOOK_SECRET` |
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
- ☐ After the first deploy, run `pnpm telegram:set-webhook` with production env. It registers `https://app.useflock.com/api/webhooks/telegram` with the secret token and the allowed updates (`message`, `callback_query`, `my_chat_member`, `chat_member`, `chat_join_request`), and sets the bot commands. Check the result with `pnpm telegram:set-webhook --info`.
- ◐ **Integration run with a real bot:**
  1. Sign in from a phone and from desktop.
  2. Connect a private channel and a private supergroup.
  3. Remove the bot's "Ban users" right and check that the dashboard shows "needs attention".
  4. Pay and join with a second Telegram account.
  5. Forward the invite to a third account and check that it is declined.
  6. Cancel, then check that the bot removes the member when access ends.

## 4. Hosting (Hetzner + Coolify)

Step-by-step: [infra/coolify/README.md](../infra/coolify/README.md). One environment, `app.useflock.com`, on Stripe test keys until launch.

- ☐ Hetzner cx33 in Nuremberg with a firewall (22 from your IP, 80, 443) and server backups.
- ☐ DNS: `app.useflock.com` and `coolify.useflock.com` → server IP.
- ☐ Coolify installed, dashboard on `https://coolify.useflock.com`, setup ports closed, GitHub App installed on the repo.
- ☐ Application from `docker-compose.coolify.yaml`, domain `https://app.useflock.com:3000` on `web`, auto-deploy on `main`.
- ☐ Environment variables set in Coolify (table in the runbook). `APP_URL` is also a build variable.
- ☐ First deploy: `migrate` prints `migrations applied`, `telegram-webhook` prints the webhook URL.
- ☐ `node tools/deploy-check.js` in the worker container passes.
- ☐ External uptime monitor on `https://app.useflock.com/api/health?worker=1`. It fails if no worker heartbeat in 2 minutes.
- ☐ Alerts on `level>=50` (error) log lines. Webhook signature failures log at warn.
- ☐ **Before live mode:** off-server database backups (pgBackRest → R2 from PR #1, or a Coolify-managed Postgres with S3 backups), then the launch-day switch in the runbook (live keys, new webhook secrets, empty database).

## 5. Pre-launch verification

- ☑ `pnpm lint`, `pnpm typecheck`, `pnpm test` (unit + integration), `pnpm build`, `pnpm test:e2e` all pass locally. These runs use local Stripe and Telegram mocks.
- ☐ CI runs the same commands on every PR. No workflow is included yet. Add one with a Postgres service.
- ☐ Load sanity check: 50 concurrent checkouts against Stripe test mode. Check that webhook p95 ingest is under 300 ms and the job queue drains.
- ☐ Restore a database backup into a scratch database once.
- ☐ Rotate every secret that was ever pasted anywhere other than Coolify.

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
