# Architecture & Product Decision Log

Each entry: context → decision → consequences. Newest decisions are appended at the bottom. Status is `Accepted` unless noted.

---

## D-001 — Next.js full-stack app + separate Node.js worker (Option 1)

**Context.** Options compared:

| Criterion | 1. Next.js + worker | 2. Next.js + Fastify API | 3. Single Node process (Next custom server + in-process jobs) |
|---|---|---|---|
| Services to run | 2 (web, worker) + Postgres | 3 (web, api, worker) + Postgres | 1 + Postgres |
| Code sharing | Workspace packages, one type system | Same, plus an HTTP contract to maintain | Same |
| Webhook handling | Route handlers on Node runtime, raw body available via `req.text()` | Fastify, also fine | Fine |
| Scheduled work independent of HTTP | Yes (worker) | Yes (worker or API process) | Fragile: tied to web lifecycle, duplicated across replicas |
| Railway cost (hobby/pro) | ~2 small services | ~3 services | ~1 service |
| Ops burden | Low | Medium (CORS/auth between web and API, two deploys of request-serving code) | Lowest, but scaling web replicas duplicates job runners |
| Scale path | Scale web and worker independently; worker uses `SKIP LOCKED` so N workers are safe | Same | Poor |

**Decision.** Option 1. Server Actions + route handlers cover all creator/subscriber mutations and webhooks; no separate API surface is needed for the MVP because there are no third-party API consumers yet. Option 2 adds a network boundary and auth plumbing for no MVP benefit. Option 3 couples scheduled revocation to web uptime, which violates "do not depend on incoming HTTP requests for scheduled processing".

**Consequences.** All domain logic lives in `packages/core` and is called by both web and worker. Webhook routes only verify, persist and enqueue; the worker does the processing.

## D-002 — Durable jobs: own Postgres job table (instead of pg-boss)

**Context.** The brief prefers pg-boss if compatible. pg-boss 12.x is compatible with Node 22 and Postgres 16. The deciding requirement is *transactional enqueue*: "webhook event persisted" and "job enqueued", or "entitlement changed" and "access job enqueued", must commit atomically. pg-boss manages its own `pg` connection; enlisting it in a Drizzle transaction requires passing a custom `db.executeSql` adapter bound to Drizzle's internal transaction client, which is not a public Drizzle API.

**Decision.** A single `jobs` table in our schema, written through Drizzle inside the same transaction as the state change. Workers claim with `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`, retries use exponential backoff with jitter, stale locks are recovered, and `dedupe_key` (partial unique index over queued/running jobs) prevents duplicate work. `LISTEN/NOTIFY` wakes the worker immediately; polling every 2 s is the fallback. Recurring tasks (expiry sweep, reconciliation, heartbeat, retention) are scheduled by the worker with time-bucketed dedupe keys so multiple worker replicas never double-run them.

**Consequences.** ~250 lines we own, covered by integration tests (including concurrent claim tests). Revisit pg-boss if we need priorities, fan-out or throughput beyond ~50 jobs/s. Jobs are inspectable with plain SQL.

## D-003 — Telegram is the only identity provider (creators and subscribers)

**Context.** Every creator and subscriber must have a verified numeric Telegram user ID anyway. Email/password adds password reset, email delivery and a second identity to link.

**Decision.** One login mechanism for everyone: a one-time, 10-minute bot deep-link challenge (`t.me/<bot>?start=l_<token>`), confirmed by an inline button in the bot chat, then claimed by the browser that holds the challenge's browser secret. Token and browser secret are 256-bit random values stored as SHA-256 hashes. A user becomes a creator when they create a creator profile.

**Consequences.** No passwords or email infrastructure in the MVP. Account recovery = Telegram account recovery. Residual risk (login-link phishing) is mitigated by an explicit confirm step and clear copy; see `security-and-compliance.md`. The Telegram Login Widget was not chosen because it needs `/setdomain` per environment and an iframe, and provides no extra assurance over a bot-confirmed challenge.

## D-004 — Stripe Accounts v2, merchant configuration, Stripe-owned pricing, direct charges

**Context.** Flock must never hold creator funds. Verified against stripe-node 23.0.0 (pinned API `2026-09-30.endive`).

**Decision.**
- Connected accounts are created with `POST /v2/core/accounts`: `dashboard: 'full'`, `defaults.responsibilities = { fees_collector: 'stripe', losses_collector: 'stripe' }`, `configuration.merchant.capabilities.card_payments.requested = true`.
- Onboarding uses Stripe-hosted v2 Account Links (`use_case.type = 'account_onboarding'`, `collection_options.fields = 'eventually_due'`). In this API version account links take no `configurations` parameter; the account's configurations drive the flow.
- Readiness = `configuration.merchant.capabilities.card_payments.status === 'active'`. `rejected` (new in endive) and `restricted` are surfaced as blocking.
- All subscriber objects (Customer, Product, Price, Checkout Session, Subscription, Billing Portal) are created **on the connected account** using the `Stripe-Account` header — direct charges. No application fee in the MVP.
- Merchant status changes arrive as v2 thin events (`v2.core.account[configuration.merchant].capability_status_updated`, `v2.core.account[requirements].updated`, `v2.core.account.updated`) on a dedicated event destination; the worker re-fetches the account. A periodic refresh is the safety net.
- Connected-account v1 snapshot events (checkout, subscription, invoice, charge, dispute) arrive on a separate Connect event destination.

**Consequences.** Stripe handles merchant fees and negative-balance liability. Creators use their own full Stripe Dashboard for refunds, payouts and disputes. Stripe's docs note Accounts v2 Billing integrations must be developed in a **Sandbox**, not legacy test mode; our instructions use Sandboxes.

## D-005 — Order-independent subscription sync ("fetch, don't trust the event")

**Decision.** Every subscription-affecting Stripe event (any type) only identifies *which* subscription changed. The worker then retrieves the subscription and its recent paid invoices from Stripe and recomputes local state under a per-subscription advisory lock. `paid_through` is derived from paid invoices (excluding refunded/disputed invoices), never from `status` alone.

**Consequences.** Duplicate and out-of-order deliveries converge to the same state. One or two extra Stripe API reads per event — negligible at MVP volume.

## D-006 — Entitlement eligibility rules

- Eligible iff: not disputed, has a non-excluded paid invoice, and `now < access_ends_at`.
- `access_ends_at = paid_through + grace`, where grace (default 48 h, `RENEWAL_GRACE_HOURS`) applies only while Stripe is still trying to collect a renewal (`active`, `past_due`).
- `canceled` (end-of-period or immediate, without refund) keeps access until `paid_through`, no grace.
- `incomplete`, `incomplete_expired` (never paid) → never eligible; grace never applies to an unpaid initial subscription.
- `unpaid`, `paused` → access until `paid_through`, no grace.
- Full refund of an invoice removes that invoice's period from `paid_through` (access typically ends immediately). Partial refunds don't change access.
- An open dispute suspends access immediately; a dispute closed as `won` restores it.

## D-007 — Telegram access via join-request invite links

**Decision.** For each grant, the bot creates a named invite link with `creates_join_request: true` and a 7-day expiry. The link itself grants nothing: when a join request arrives, the worker approves it only if the requesting Telegram user ID has an active entitlement for that chat, and declines it otherwise. Forwarded links therefore cannot admit unpaid users.

**Removal** = `banChatMember` followed immediately by `unbanChatMember(only_if_banned)`, so the user is removed but can rejoin after a future payment. Before removal the worker re-checks entitlements (any other active entitlement for the same community wins) and the member's status (`creator`/`administrator` are never removed).

## D-008 — Chat ownership verification via `my_chat_member`

A typed username is never accepted as proof. The creator starts a connection in Flock (creates a 30-minute pending connection request), then adds the bot as admin via a `startgroup`/`startchannel` deep link that pre-selects the required rights. Telegram's `my_chat_member` update tells us (authenticated) which Telegram user promoted the bot in which numeric chat. We connect only if: that user has a pending request; `getChatMember` shows that user is `creator` or `administrator`; the bot is an administrator with `can_invite_users` and `can_restrict_members`; and the chat isn't connected to another community.

## D-009 — One community and one active plan per creator in the MVP

Schema supports many (communities per creator, plans per community, price versions per plan). The app enforces one community per creator and one active plan per community via configuration constants. Changing a plan's price creates a **new Stripe Price**; existing subscribers stay on their original price (grandfathered). This avoids mutating Stripe Prices, which Stripe does not allow for amounts.

## D-010 — Flock's own SaaS billing: implemented, disabled by default

Stripe Billing on the platform account (Checkout + Billing Portal + webhook sync into `platform_subscriptions`) is implemented behind `PLATFORM_BILLING_ENABLED=false`. During the beta every creator is on the free "Early access" plan and the UI says so plainly. Prices live in `packages/core/src/pricing.ts` and Stripe Price IDs in env. Real charges must not be enabled until the legal checkout requirements (terms acceptance, tax registration decisions, refund policy) are confirmed by the founder. Platform billing uses a v1 Customer on the platform account; Accounts v2 "customer configuration" was not used because it requires a Sandbox-only flow and adds coupling to the merchant account.

## D-011 — No in-bot payments; the bot never sends checkout links

The bot authenticates users and manages access. It never sends Stripe Checkout or Billing Portal URLs. Payment happens on the independent website. Telegram Stars subscriptions are a possible later option.

## D-012 — Versions pinned

Node 22 LTS, TypeScript 6.0 (TS 7 native compiler skipped: Next.js's type-check step relies on the JS compiler API), Next.js 16 (App Router, Turbopack), React 19, Tailwind 4, Drizzle ORM 0.45 + drizzle-kit 0.31 on `pg` 8, grammY 1.46 (`Api` client only — we don't use grammY's router since updates are processed by the worker), stripe-node 23 (API `2026-09-30.endive`), Zod 4, Pino 10, Vitest 5, Playwright 1.56.

## D-013 — shadcn/ui-style components written in-repo

shadcn/ui is a copy-in component pattern; its CLI fetches from a registry. Components were written in the same pattern (small, owned components styled with Tailwind tokens, `cn()` via clsx + tailwind-merge) directly in `apps/web/components/ui`. The MVP needed no overlay primitives, so no Radix dependency yet; confirmations use the native `confirm()` dialog. Registry versions can be swapped in later.

## D-014 — Local development without tunnels for Telegram

The worker supports `TELEGRAM_MODE=polling` (`getUpdates`) for local development; updates go through the exact same ingest → persist → job pipeline as the webhook. Production uses webhooks with `secret_token`.

## D-015 — Provider overrides only outside production

`TELEGRAM_API_ROOT` and `STRIPE_API_HOST/PORT/PROTOCOL` let tests point at local provider mocks. They are ignored when `FLOCK_ENV=production`, so production cannot be pointed at a fake provider by misconfiguration.

## D-016 — Demo data is never sent to providers

Seed data (`pnpm db:seed`) is flagged `is_demo` on users, creators and communities, uses negative Telegram user IDs (Telegram user IDs are positive, so no real account can collide) and `*_demo_*` Stripe IDs. Checkout refuses demo communities, and the expiry sweep and hourly reconciliation skip them, so no demo row ever produces a Stripe or Telegram API call. The seed refuses to run with `FLOCK_ENV=production`.

## D-017 — MRR definition

Dashboard MRR = sum of the monthly price of subscriptions with an active entitlement, Stripe status `active`/`trialing`/`past_due`, and **not** set to cancel at period end. Grouped by currency, never converted or summed across currencies. It is shown "before Stripe fees".

## D-018 — Hetzner + Coolify from day 1, one environment until launch

Flock runs on one Hetzner server (cx33, Nuremberg, near Telegram's Bot API in Amsterdam) managed by self-hosted Coolify, instead of Railway. Coolify builds `infra/docker/Dockerfile` on the server and runs `docker-compose.coolify.yaml`: Postgres, a one-shot migration, web, worker, and a one-shot Telegram webhook registration. Pushes to `main` deploy.

There is one environment, `app.useflock.com`. It runs on Stripe test keys until launch; at launch it switches to live keys and new webhook secrets with an empty database, because test-mode Stripe objects don't exist in live mode. A staging copy (same compose file, own domain, bot and test keys) gets added once real creators depend on production. Off-server database backups are required before live mode.

The Stripe webhook destinations are created by `pnpm stripe:webhooks --create` rather than in the dashboard, so the snapshot endpoints are pinned to the SDK's API version and the event lists come from one place (`packages/payments/src/webhook-destinations.ts`).

The OpenTofu/Caddy/pgBackRest setup in PR #1 stays as reference; its pgBackRest → R2 backups are one option for the pre-launch backup requirement.
