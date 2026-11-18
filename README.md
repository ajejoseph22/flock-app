# Flock

Paid memberships for private Telegram channels and groups ([useflock.com](https://useflock.com); the app runs at [app.useflock.com](https://app.useflock.com)).

Creators connect a Telegram chat and their own Stripe account, set a monthly price, and share one link. Members sign in with Telegram and pay on Stripe Checkout. The Flock bot then:

- sends each paying member a personal, join-request invite;
- approves only that member;
- removes members when their access ends, after a refund, or after a dispute.

## Status

| Area | Status |
|---|---|
| Web app, worker, database, bot logic | **Implemented** |
| Unit, integration and E2E tests | **Tested** against local mocks of Stripe and Telegram |
| Real Stripe test mode / real Telegram bot | **Not yet integrated**. See [docs/launch-checklist.md](docs/launch-checklist.md) |
| Hetzner + Coolify | **Not deployed**. Compose stack built and booted locally; see [infra/coolify/README.md](infra/coolify/README.md) |

## Stack

TypeScript everywhere, in a pnpm monorepo:

| Package | Contents |
|---|---|
| `apps/web` | Next.js 16 (App Router), React 19, Tailwind 4, shadcn-style components. Marketing site, dashboard, membership pages, auth and webhook endpoints. |
| `apps/worker` | Node job runner: webhook processing, Telegram access operations, cron sweeps. |
| `packages/core` | Domain logic and services. Framework-free, so it can be tested directly. |
| `packages/db` | Drizzle schema, migrations and the demo seed (Postgres). |
| `packages/payments` | Stripe gateway (Accounts v2 + direct charges) and webhook verification. |
| `packages/telegram` | grammY-based Bot API gateway, webhook handler, polling for local dev. |
| `tests/` | Vitest integration suites, Playwright E2E, and local **mocks** of the Stripe and Telegram APIs. |

Further reading:

- Design: [docs/architecture.md](docs/architecture.md) and [docs/payment-and-access-lifecycle.md](docs/payment-and-access-lifecycle.md).
- Decisions: [docs/decisions.md](docs/decisions.md).
- Other docs: [user stories](docs/user-stories.md), [database](docs/database-design.md), [security](docs/security-and-compliance.md).

## Local development

Requirements: Node ≥ 22.12, pnpm 10, Postgres 16.

```bash
pnpm install
cp .env.example .env        # then fill in the blanks (see below)
pnpm db:migrate
pnpm dev                    # web on http://localhost:3000
pnpm worker:dev             # in a second terminal
```

For `.env` you need:

- **A development Telegram bot.** Create it with @BotFather and set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME`. Keep `TELEGRAM_MODE=polling` locally, so the worker long-polls Telegram and no public URL or tunnel is needed.
- **A random `TELEGRAM_WEBHOOK_SECRET`.** For example, from `openssl rand -hex 32`.
- **Stripe test mode keys.** Use a test-mode `STRIPE_SECRET_KEY` from your Flock platform account. For webhooks, run the Stripe CLI and put the printed `whsec_…` values in the three `STRIPE_*_WEBHOOK_SECRET` variables:

  ```bash
  stripe listen --forward-to localhost:3000/api/webhooks/stripe/platform \
    --forward-connect-to localhost:3000/api/webhooks/stripe/connect
  stripe listen --thin-events 'v2.core.account*' --forward-thin-to localhost:3000/api/webhooks/stripe/accounts
  ```

Never put real keys in source files or docs. `.env` is git-ignored.

### Demo data

```bash
pnpm db:seed           # creates /join/demo-market-notes with 8 demo members
pnpm db:seed --reset   # recreate it
```

Demo data is clearly labelled in the UI and can't take payments. It is never sent to Stripe or Telegram (D-016). To browse it in the dashboard:

1. Sign in once locally.
2. Set `SEED_OWNER_TELEGRAM_USER_ID` to your Telegram ID.
3. Run `pnpm db:seed --reset`.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` / `pnpm worker:dev` | Run web / worker in watch mode |
| `pnpm db:migrate` / `pnpm db:generate` | Apply / generate SQL migrations |
| `pnpm db:seed` | Demo data (refuses in production) |
| `pnpm lint` | ESLint (flat config) |
| `pnpm typecheck` | `tsc` for every package, tests and scripts |
| `pnpm test` | Unit and integration tests (Vitest) against Postgres `flock_test` and the provider mocks |
| `pnpm test:e2e` | Playwright against a production build, the real worker, Postgres `flock_e2e`, and the provider mocks |
| `pnpm build` | Production build of all packages, worker and web |
| `pnpm telegram:set-webhook` | Register the Telegram webhook for `APP_URL` (`--info` to inspect) |

Tests need a local Postgres reachable as `postgres://postgres@127.0.0.1:5432`. Override with `TEST_DATABASE_URL` / `E2E_DATABASE_URL`. The test runs drop and recreate their own databases.

> **About the mocks.** `tests/mocks` are local fakes of the Stripe and Telegram HTTP APIs. The real `stripe` and `grammy` clients talk to them, and Stripe webhooks are signed exactly like Stripe's, so signature verification, idempotency and ordering logic run for real. They are **not** the real providers. Passing tests mean the system is **Tested**, not **Integrated**.

## Stripe Connect setup

1. In the Stripe dashboard for Flock's platform account, enable **Connect** and complete the platform profile.
2. Flock creates each creator's account with **Accounts v2** (`merchant` configuration) and sends them to Stripe-hosted onboarding. Creators never give Flock keys or bank details.
3. Payments are **direct charges** on the creator's account (Checkout Sessions created with the `Stripe-Account` header). Flock takes no application fee.
4. Create the three webhook destinations listed in [docs/launch-checklist.md](docs/launch-checklist.md#2-stripe-configuration-test-mode-first-then-live) and set their signing secrets.
5. A creator can publish only once Stripe reports `card_payments` **active** on their account.

## Telegram setup

1. Create the bot with @BotFather. No special BotFather settings are required: the bot works through admin rights in each chat, and privacy mode can stay on.
2. Deploy, then run `pnpm telegram:set-webhook` with production env. Telegram will call `/api/webhooks/telegram` with `X-Telegram-Bot-Api-Secret-Token`, and requests without the right secret get a 401.
3. Creators add the bot to their private channel or supergroup as an admin with **Invite users via link** and **Ban users**. Flock verifies both rights and that the person connecting is an owner or admin of the chat.

## Deployment (Hetzner + Coolify)

One Hetzner server runs Coolify, which builds [`infra/docker/Dockerfile`](infra/docker/Dockerfile) and runs [`docker-compose.coolify.yaml`](docker-compose.coolify.yaml) on every push to `main`: Postgres, a one-shot `migrate`, `web` (health `/api/health`), `worker` (health `/health`), and a one-shot that registers the Telegram webhook. `app.useflock.com` runs on Stripe test keys until launch.

Setup, variables, the Stripe test-mode run and the launch-day switch to live: [infra/coolify/README.md](infra/coolify/README.md).

| Command | What it does |
|---|---|
| `pnpm stripe:webhooks --app-url <url> [--create]` | Check, or create, the three Stripe webhook destinations and print their signing secrets |
| `pnpm deploy:check` (or `node tools/deploy-check.js` in the worker container) | Preflight: config, DB, Telegram bot and webhook, Stripe account and webhooks, health |

## License

[MIT](LICENSE) © 2026 Joseph Aje
