# Architecture

## 1. System overview

```
                         ┌─────────────────── Hetzner server (Coolify) ────────────────────┐
  Browser ──HTTPS──▶     │  web (Next.js 16, Node runtime)          worker (Node 22)       │
  (creator/subscriber)   │  ├─ pages: marketing, dashboard, join   ├─ job runner (SKIP     │
                         │  ├─ server actions (mutations)          │  LOCKED + LISTEN)     │
  Telegram ──webhook──▶  │  ├─ /api/webhooks/telegram  ─┐          ├─ schedulers: expiry,   │
  Stripe ───webhooks──▶  │  ├─ /api/webhooks/stripe/*  ─┤ persist  │  reconcile, heartbeat, │
                         │  └─ /api/health              │ + enqueue│  retention             │
                         │                               ▼          ├─ Telegram polling     │
                         │                     ┌──────────────────┐ │  (dev only)           │
                         │                     │   PostgreSQL 16  │◀┘                       │
                         │                     │ app tables + jobs│                         │
                         │                     └──────────────────┘                         │
                         └──────────────────────────────────────────────────────────────────┘
        web & worker ──HTTPS──▶ api.telegram.org (Bot API)   ──HTTPS──▶ api.stripe.com (v1 + v2)
```

- **web** serves UI and accepts webhooks. Webhook routes do three things only: verify authenticity, persist the raw event idempotently, enqueue a processing job in the same transaction. They return 200 once persisted.
- **worker** processes all jobs: webhook events, Telegram access operations, merchant refreshes, and scheduled sweeps. It's horizontally safe (multiple replicas can run).
- **Postgres** is the single source of local truth and the job queue.

## 2. Repository layout

```
flock/
  apps/
    web/                    Next.js App Router app
      app/(marketing)/      /, /pricing, /terms, /privacy, /contact
      app/(auth)/login/     Telegram sign-in
      app/(dashboard)/      /dashboard, /dashboard/setup, /members, /plans, /settings, /billing
      app/join/[slug]/      public membership page + /status
      app/account/          subscriber memberships + billing portal
      app/admin/            operator page (ADMIN_TELEGRAM_USER_IDS)
      app/api/              webhooks, auth challenge, polling endpoints, health
      components/ui/        shadcn-style primitives
      lib/                  session helpers, service wiring, formatting
    worker/src/             job handlers, schedulers, polling, health server
  packages/
    db/                     Drizzle schema, client, migrations, seed
    core/                   config, logger, domain rules (pure), services (orchestration), jobs
    telegram/               Bot API gateway (grammY Api), deep links, update parsing
    payments/               Stripe client factory, StripeGateway, webhook verification
  tests/
    integration/            Vitest against real Postgres + provider fakes
    e2e/                    Playwright against built app + worker + provider mocks
    mocks/                  Local HTTP mocks of the Telegram Bot API and Stripe API
  docs/  scripts/
```

Dependency direction: `web, worker → core → db`; `web, worker → telegram, payments → core (types only)`. Domain rules in `core/src/domain` are pure functions with no I/O. Services in `core/src/services` take a `Deps` object (`db`, `telegram: TelegramGateway`, `stripe: StripeGateway`, `clock`, `config`) so tests inject fakes.

## 3. Key flows

### 3.1 Sign-in (creator and subscriber)
1. Browser `POST /api/auth/challenge` → server creates `auth_challenges` row with `sha256(token)` and `sha256(browserSecret)`; sets HTTP-only cookie `flock_challenge=<id>.<browserSecret>`; returns `t.me/<bot>?start=l_<token>`.
2. User taps → Telegram sends `/start l_<token>` → webhook → job → bot asks to confirm.
3. Confirm button (callback query from the same Telegram user) → challenge `confirmed`, user upserted.
4. Browser polls `POST /api/auth/challenge/status`; on `confirmed` the server atomically marks it `consumed`, creates a session, sets `flock_session`.

### 3.2 Chat connection
`connection request (30 min) → creator adds bot via deep link → my_chat_member update → verify (creator status, bot rights, uniqueness) → telegram_chats row`. Web polls the request status.

### 3.3 Checkout → access
`join page → checkout intent → Checkout Session (Stripe-Account) → Stripe → webhook (connect destination) → job: syncConnectedSubscription (retrieve subscription + paid invoices) → subscription row → entitlement (eligibility) → enqueue access.reconcile → access.issue_invite → createChatInviteLink(creates_join_request) → DM → chat_join_request → access.handle_join_request → approve`.

### 3.4 Expiry and revocation
Every minute the worker selects active entitlements with `access_ends_at <= now()`, re-evaluates them and enqueues `access.reconcile`. The revoke job re-checks desired state, skips admins/owners, then ban + unban(only_if_banned).

### 3.5 Reconciliation (hourly)
1. Re-sync from Stripe every subscription that is non-terminal or ended in the last 7 days (oldest `last_synced_at` first, capped per run).
2. Compare desired access (any active entitlement) with grant state for all grants; enqueue repairs.
3. Spot-check `getChatMember` for grants in `member` state (capped per run) to detect silent leaves.
4. Refresh merchant accounts not synced in 24 h.
5. Re-verify bot permissions for connected chats.

## 4. Webhook endpoints

| Path | Source | Verification | Events |
|---|---|---|---|
| `/api/webhooks/telegram` | Telegram | `X-Telegram-Bot-Api-Secret-Token` (constant-time) | `message`, `callback_query`, `my_chat_member`, `chat_member`, `chat_join_request` |
| `/api/webhooks/stripe/connect` | Stripe Connect event destination (connected accounts, snapshot) | `Stripe-Signature` with `STRIPE_CONNECT_WEBHOOK_SECRET` | `checkout.session.completed/expired/async_payment_*`, `customer.subscription.*`, `invoice.paid/payment_failed/payment_action_required/finalized`, `charge.refunded`, `charge.dispute.created/closed`, `account.updated` |
| `/api/webhooks/stripe/platform` | Platform account destination (snapshot) | `STRIPE_PLATFORM_WEBHOOK_SECRET` | Flock's own SaaS billing: `checkout.session.completed`, `customer.subscription.*`, `invoice.*` |
| `/api/webhooks/stripe/accounts` | v2 thin event destination | `parseEventNotification` with `STRIPE_ACCOUNTS_WEBHOOK_SECRET` | `v2.core.account.updated`, `v2.core.account[configuration.merchant].capability_status_updated`, `v2.core.account[requirements].updated` |

Body size limit: 1 MB (Stripe) / 256 KB (Telegram). Raw body read with `req.text()` before parsing.

## 5. Jobs

| Type | Trigger | Idempotency |
|---|---|---|
| `webhook.process` | each persisted webhook event | event row status; handlers are state-based |
| `stripe.sync_subscription` | events, reconciliation | per-subscription advisory lock, recompute from Stripe |
| `stripe.refresh_merchant` | thin events, return URL, reconciliation | overwrite from Stripe |
| `access.reconcile` | any entitlement change | dedupe key `access:<user>:<community>` |
| `access.issue_invite` / `access.revoke` / `access.handle_join_request` | from reconcile / join request | re-check desired state at execution time |
| `telegram.notify` | best-effort DMs | dedupe key per notification |
| `cron.expiry_sweep` (1 min), `cron.reconcile` (1 h), `cron.retention` (1 d) | worker scheduler | time-bucket dedupe key |

Retry policy: exponential backoff `min(2^attempt × 5 s, 1 h)` ± 20% jitter; Telegram 429 uses `retry_after`; default `max_attempts = 10` (≈ 24 h), then `dead` (visible on `/admin`). Permanent errors (e.g. invalid chat) fail fast and mark the entity `needs_attention`.

## 6. Configuration

All environment variables are parsed by Zod in `packages/core/src/config.ts` at startup; the process refuses to start with invalid config. See `.env.example`.

## 7. Deployment (Hetzner + Coolify)

- One Hetzner server (Nuremberg) runs Coolify. Coolify builds `infra/docker/Dockerfile` (targets `web` and `worker`) and runs `docker-compose.coolify.yaml` on every push to `main`.
- Order: `postgres` healthy → `migrate` (one-shot, `node migrate/dist/migrate.js`) → `web` (Next.js standalone, health `/api/health`) and `worker` (health `/health` on 8081) → `telegram-webhook` (one-shot).
- Postgres 16 in the same compose project, on a named volume. Only `web` is exposed, through Coolify's Traefik proxy with Let's Encrypt.
- Domain: `app.useflock.com` → web (the marketing site at `useflock.com` is hosted separately on Vercel).
- Runbook: `infra/coolify/README.md`. D-018.

## 8. Scaling notes

A single web instance (512 MB) and worker (256–512 MB) handle thousands of subscribers. Bottlenecks in order: Telegram global send limit (~30 msg/s) for DMs, then Stripe read rate limits during reconciliation (100 rps live), then Postgres. Reconciliation is batched and capped per run.
