# Database design

Postgres 16, accessed with Drizzle ORM (`packages/db/src/schema.ts` is the source of truth; SQL migrations in `packages/db/migrations`). Column names are snake_case; TypeScript names are camelCase.

Conventions:

- Primary keys are UUIDs (`gen_random_uuid()`).
- All timestamps are `timestamptz`.
- Money is an integer count of the currency's **minor unit** (`*_minor`), with a lowercase 3-letter currency next to it. Amounts are never summed across currencies.
- Telegram IDs are `bigint` (mode `number`; Telegram guarantees they fit in 52 bits).
- Secrets and tokens are never stored in plaintext. Sessions, login tokens and browser secrets are stored as SHA-256 hashes.
- Stripe is the source of truth for billing. Our rows are a cache plus derived state, and every billing change re-reads Stripe (see [payment-and-access-lifecycle.md](payment-and-access-lifecycle.md)).
- `is_demo` marks seed data (D-016).

## Entity overview

```
users ─┬─ sessions
       ├─ auth_challenges (login)
       └─ creators ─┬─ merchant_accounts (Stripe connected account)
                    ├─ platform_subscriptions (Flock SaaS billing)
                    └─ communities ─┬─ telegram_chats (1:1)
                                    ├─ chat_connection_requests
                                    └─ membership_plans ── plan_prices (immutable versions)

users × merchant_accounts ── subscriber_customers (Stripe Customer per connected account)
checkout_intents → subscriptions → invoices
                       └─ entitlements (1:1, "may this user be in this community")
users × communities ── telegram_access_grants (Telegram-side state, 1 per pair)

infrastructure: webhook_events, jobs, audit_logs, analytics_events, rate_limits, worker_heartbeats
```

## Tables

### Identity

| Table | Purpose | Key constraints |
|---|---|---|
| `users` | One person = one verified Telegram user ID. Name/username refreshed on each sign-in. `bot_chat_started`/`bot_blocked_at` track whether the bot can DM them. | `telegram_user_id` unique |
| `sessions` | Browser sessions (30 days). | `token_hash` unique; cascade on user delete |
| `auth_challenges` | Telegram deep-link login. Status `pending → claimed → confirmed → consumed`, or `rejected`/`expired`. Stores `token_hash` (deep-link payload) and `browser_secret_hash` (HTTP-only cookie), the claiming Telegram user, `return_to`, 10-minute expiry. Every transition is a conditional `UPDATE … WHERE status = …`. | `token_hash` unique |

### Creators and Stripe

| Table | Purpose | Key constraints |
|---|---|---|
| `creators` | A user who runs a community. `platform_plan` (`beta`/`starter`/`growth`), `platform_stripe_customer_id` for Flock's own billing, `contact_email` (given at Stripe onboarding). | `user_id` unique |
| `merchant_accounts` | The creator's Stripe Accounts v2 account. Caches `card_payments_status` (readiness = `active` and not disconnected), requirements, default currency, billing-portal configuration ID. `livemode` recorded at creation. | `creator_id` unique, `stripe_account_id` unique |
| `platform_subscriptions` | Creator → Flock subscriptions on the platform account (disabled in early access). | `stripe_subscription_id` unique |

### Communities and Telegram

| Table | Purpose | Key constraints |
|---|---|---|
| `communities` | Public page content (`name`, `slug`, description, benefits JSON array, support contact, avatar URL) and `status` (`draft`/`published`/`archived`). | `slug` unique (validated, reserved words blocked, immutable after creation) |
| `telegram_chats` | The chat connected to a community: Telegram chat ID, type, title, `status` (`connected`/`needs_attention` + reason), the bot's verified rights, `last_verified_at`. | `community_id` unique (one chat per community), `telegram_chat_id` unique (a chat can't be claimed by two communities) |
| `chat_connection_requests` | A creator's 30-minute intent to connect a chat. Matched against an authenticated `my_chat_member` update from the **same Telegram user**. Records failure code/message for the UI. | index on (`telegram_user_id`, `status`) |

### Plans

| Table | Purpose | Key constraints |
|---|---|---|
| `membership_plans` | A monthly plan, bound to the merchant account and Stripe Product. `current_price_id` points at the price new checkouts use. | one active plan per community enforced in the service (D-009) |
| `plan_prices` | Immutable price versions (Stripe Prices can't change amount). A price change inserts a new row and archives the old Stripe Price; existing subscribers keep theirs. | `amount_minor > 0`, `currency = lower(currency)`, `stripe_price_id` unique |

### Billing and access

| Table | Purpose | Key constraints |
|---|---|---|
| `subscriber_customers` | The member's Stripe Customer on a given connected account. | unique (merchant, user) and (merchant, stripe customer) |
| `checkout_intents` | Server-side record created **before** Checkout: user, community, plan, price, merchant, customer. Its ID is the Checkout `client_reference_id`, and it scopes the status page to its owner. Status `created → open → completed / expired / failed`. | index (user, community) |
| `subscriptions` | Cache of the Stripe subscription plus derived fields: `paid_through` (end of the latest paid, non-excluded invoice period), `excluded_invoice_ids` (full refunds, lost disputes), `open_dispute_ids`, `latest_invoice_refunded`, `last_synced_at`. | unique (merchant, stripe subscription id) |
| `invoices` | Paid and attempted invoices: amount paid, period end, paid at, refunded flag. Used for `paid_through` and the creator's payment history. | unique (merchant, stripe invoice id) |
| `entitlements` | **The authoritative access decision**, one per subscription: `status` (`active`/`ended`), `reason` (`active`, `grace_period`, `canceled_until_period_end`, `payment_failed`, `refunded`, `disputed`, `expired`, `never_paid`), `access_ends_at`. Written only by billing sync under an advisory lock. | `subscription_id` unique; index (`status`, `access_ends_at`) for the expiry sweep |
| `telegram_access_grants` | Telegram-side state per (user, community): `state` (`pending`/`invited`/`member`/`left`/`revoking`/`revoked`/`failed`), `desired`, the personal invite link and its expiry, join/revoke times, last error. Converged by `access.reconcile` jobs. | unique (user, community) |

A user is allowed in a community's chat if and only if they have **any** active entitlement for it with `access_ends_at > now()`.

### Infrastructure

| Table | Purpose | Key constraints |
|---|---|---|
| `webhook_events` | Every verified Telegram/Stripe event, stored raw before processing. `status` `pending/processed/ignored/failed`, `attempts`, `last_error`. | unique (`provider`, `external_id`): the idempotency key (Stripe event ID; Telegram `update_id` + payload digest) |
| `jobs` | Postgres job queue (D-002). Claimed with `FOR UPDATE SKIP LOCKED`; exponential backoff with jitter; `dead` after `max_attempts`; stale locks recovered. | partial unique index on `dedupe_key WHERE status = 'queued'`, so running jobs never swallow a newer state change; index (`status`, `run_at`) |
| `audit_logs` | Who/what changed access, plans, chats, Stripe status. Feeds the member timeline. | index (community, subject user, created_at) |
| `analytics_events` | First-party product events (funnel: creator registered → … → access granted). No third-party trackers. | index (name, created_at) |
| `rate_limits` | Fixed-window counters for auth, checkout, Stripe actions. | key primary key |
| `worker_heartbeats` | Liveness of worker processes, checked by `/api/health?worker=1` and `/admin`. | `worker_id` primary key |

## Concurrency and integrity

- **Per-subscription serialization.** Billing sync takes `pg_advisory_xact_lock(hashtextextended('sub:<account>:<id>'))`, re-reads Stripe, and writes subscription, invoices and entitlement in one transaction. Events can arrive in any order or be replayed; the result only depends on Stripe's current state.
- **Per-grant serialization.** Access operations lock on (user, community) and re-check the desired state after every Telegram call, so a late invite can't overwrite a newer revoke.
- **Transactional enqueue.** A webhook is persisted and its job enqueued in the same transaction, so the 2xx response to the provider guarantees the work will happen.
- **Tenant isolation.** Creator pages always load data through `getOwnedCommunity(creatorId)`. Member detail requires a subscription in that community. Subscriber pages are scoped by session user ID.

## Retention

The daily `cron.retention` job:

- deletes expired sessions;
- deletes auth challenges after 24 hours and stale rate-limit windows;
- deletes finished jobs after 14 days;
- deletes processed and ignored webhook events after 30 days (failed ones are kept for investigation);
- deletes analytics events after 400 days.

Membership, invoice and audit rows are kept for the life of the community, for billing and dispute history.

## Migrations

- `pnpm db:generate` creates SQL from schema changes (drizzle-kit).
- `pnpm db:migrate` applies them. It runs as the one-shot `migrate` service before web and worker start on every deploy, so the new schema is in place before new code serves traffic.
- Migrations must be backwards compatible with the previous release (add, backfill, then remove in a later release), because the worker and web deploy independently.
