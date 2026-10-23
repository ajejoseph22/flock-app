# Flock on Hetzner with Coolify

One Hetzner server runs Coolify, Postgres and the app. There is one environment, `app.useflock.com`. It runs on **Stripe test keys until launch** and switches to live keys on launch day ([§9](#9-launch-day-switch-to-live-mode)). Add a separate staging app on the same server once real creators are paying ([§10](#10-later-a-staging-copy)).

```
GitHub push to main ─▶ Coolify (builds infra/docker/Dockerfile on the server)
                          │
   https://app.useflock.com ─▶ Traefik (Coolify proxy, Let's Encrypt)
                          │
             ┌────────────┴─────────────┐
             ▼                          ▼
           web :3000                worker :8081 (health only)
             └──────────┬───────────────┘
                        ▼
                  postgres :5432 (volume flock-pgdata)
```

Deploy order on every push (from [`docker-compose.coolify.yaml`](../../docker-compose.coolify.yaml)):
`postgres` healthy → `migrate` runs and exits 0 → `web` + `worker` start → once `web` is healthy, `telegram-webhook` registers the bot webhook and exits.

Nothing here has been run against real Hetzner, Coolify, Stripe or Telegram yet. The compose stack was built and booted locally (migrations, web and worker healthy). Coolify's UI labels below are from its v4 docs and may differ slightly in your version.

## 1. Server

Pick a **cx33** (4 vCPU, 8 GB) in **Nuremberg (nbg1)**. Coolify needs about 1–2 GB for itself, and Next.js builds run on the same box. A cx23 (4 GB) works only with swap and slow builds. Nuremberg is close to Telegram's Bot API in Amsterdam.

With the [hcloud CLI](https://github.com/hetznercloud/cli) on your laptop:

```bash
hcloud context create flock                      # paste a Read & Write API token from the Hetzner project
hcloud ssh-key create --name ayo --public-key-from-file ~/.ssh/id_ed25519.pub

MYIP=$(curl -s https://ifconfig.me)
hcloud firewall create --name flock
hcloud firewall add-rule flock --direction in --protocol tcp --port 22   --source-ips "$MYIP/32"
hcloud firewall add-rule flock --direction in --protocol tcp --port 80   --source-ips 0.0.0.0/0 --source-ips ::/0
hcloud firewall add-rule flock --direction in --protocol tcp --port 443  --source-ips 0.0.0.0/0 --source-ips ::/0
# Coolify's setup ports, only until coolify.useflock.com works (step 3); then delete these three rules.
for p in 8000 6001 6002; do hcloud firewall add-rule flock --direction in --protocol tcp --port $p --source-ips "$MYIP/32"; done

hcloud server create --name flock-1 --type cx33 --image ubuntu-24.04 --location nbg1 \
  --ssh-key ayo --firewall flock --enable-backup
hcloud server ip flock-1
```

`--enable-backup` turns on Hetzner's daily server snapshots (+20% of the server price). That's enough while everything is test data. Before launch, add real database backups ([§9](#9-launch-day-switch-to-live-mode)).

The Hetzner console works too: same type, location, image, SSH key, firewall and backups.

## 2. DNS

Two A records (and AAAA if you want IPv6) pointing at the server IP:

| Name | Purpose |
|---|---|
| `app.useflock.com` | Flock |
| `coolify.useflock.com` | Coolify dashboard |

`useflock.com` and `www` stay on Vercel.

## 3. Install Coolify

```bash
ssh root@<server-ip>
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

Then open `http://<server-ip>:8000`:

1. Create the admin account at once, since the first visitor becomes the admin. Use a password manager and turn on 2FA in your profile.
2. **Settings → General → Instance domain**: `https://coolify.useflock.com`. Wait for the certificate, then log in there.
3. Delete the firewall rules for 8000, 6001 and 6002. From then on, use only `https://coolify.useflock.com`.
4. **Servers → localhost**: check that the proxy (Traefik) is running.

## 4. Connect GitHub

**Sources → + Add → GitHub App**. Create it on your personal account and install it on `ajejoseph22/flock` only. Coolify then gets push webhooks for auto-deploy.

## 5. Create the app

1. **Projects → + Add** `Flock` → environment `production` → **+ New resource → Private Repository (with GitHub App)**.
2. Repository `ajejoseph22/flock`, branch `main`.
3. **Build pack: Docker Compose**. Base directory `/`, Docker Compose location `/docker-compose.coolify.yaml`.
4. After Coolify reads the file, set the **domain** on the `web` service to `https://app.useflock.com:3000`. The `:3000` tells Traefik which container port to use. Leave every other service without a domain.
5. Turn on **Auto deploy** (General → Advanced) so pushes to `main` deploy.

## 6. Environment variables

Set these under the app's **Environment Variables** tab. Never commit them or paste them in chat.

| Variable | Value | Notes |
|---|---|---|
| `APP_URL` | `https://app.useflock.com` | Must be available at **build time** too (tick "Build Variable" / "Available at Buildtime"), because static pages bake it in. |
| `TELEGRAM_BOT_TOKEN` | from @BotFather | The production bot. Bot usernames are permanent, so use the real name. |
| `TELEGRAM_BOT_USERNAME` | e.g. `flock_bot` | No `@`. |
| `TELEGRAM_WEBHOOK_SECRET` | `openssl rand -hex 32` | Telegram echoes it on every webhook. |
| `STRIPE_SECRET_KEY` | `sk_test_…` or `rk_test_…` | Test mode until launch. |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | `whsec_…` | From [§7](#7-stripe-webhooks). |
| `STRIPE_PLATFORM_WEBHOOK_SECRET` | `whsec_…` | From [§7](#7-stripe-webhooks). |
| `STRIPE_ACCOUNTS_WEBHOOK_SECRET` | `whsec_…` | From [§7](#7-stripe-webhooks). |
| `ADMIN_TELEGRAM_USER_IDS` | your numeric Telegram ID | Opens `/admin`. Comma-separate several. |

Optional (defaults in brackets): `FLOCK_ENV` [`production`], `LOG_LEVEL` [`info`], `PLATFORM_BILLING_ENABLED` [`false`], `RENEWAL_GRACE_HOURS` [`48`], `INVITE_LINK_TTL_HOURS` [`168`], `SUPPORT_EMAIL` [`support@useflock.com`], `WORKER_CONCURRENCY` [`4`].

Set by Coolify, don't touch: `SERVICE_USER_POSTGRES`, `SERVICE_PASSWORD_POSTGRES` (generated on the first deploy; `DATABASE_URL` is built from them). `TELEGRAM_MODE` is fixed to `webhook` in the compose file.

`FLOCK_ENV=production` on test keys is intended. The app behaves exactly as it will at launch, requires https, and ignores the local mock overrides (D-015). The dashboard shows a test-mode banner whenever the Stripe key is a test key.

## 7. Stripe webhooks

The app won't boot without the three `whsec_…` secrets, so create the destinations first, from your laptop:

```bash
STRIPE_SECRET_KEY=sk_test_… pnpm stripe:webhooks --app-url https://app.useflock.com           # check only
STRIPE_SECRET_KEY=sk_test_… pnpm stripe:webhooks --app-url https://app.useflock.com --create  # create missing
```

`--create` makes the three destinations and prints each signing secret **once**, as `VARIABLE=whsec_…`. Paste them into Coolify straight away. Use a full `sk_test_` key here (or a restricted key with Webhook write); the app itself can keep a narrower restricted key.

| Destination | URL | Kind |
|---|---|---|
| Connected accounts | `/api/webhooks/stripe/connect` | snapshot, events from connected accounts |
| Platform | `/api/webhooks/stripe/platform` | snapshot, your account |
| Accounts v2 | `/api/webhooks/stripe/accounts` | thin events, your account |

The event lists live in [`packages/payments/src/webhook-destinations.ts`](../../packages/payments/src/webhook-destinations.ts). The snapshot endpoints are pinned to the API version the SDK uses, which the dashboard doesn't do by default. That's the main reason to prefer the script over clicking. The script never edits or deletes an existing destination. If one is wrong, delete it in the dashboard and rerun with `--create`.

## 8. First deploy and test-mode run

1. **Deploy** in Coolify. Watch the logs: `migrate` should print `migrations applied`, and `telegram-webhook` should print `Webhook set to https://app.useflock.com/api/webhooks/telegram`.
2. Run the preflight in the worker container (**worker → Terminal**):

   ```bash
   node tools/deploy-check.js
   ```

   It checks config, the database and migrations, the bot token and webhook, the Stripe platform account, whether Accounts v2 is available, the three webhook destinations, and `/api/health?worker=1`. Fix anything marked ✘.
3. Walk through the integration runs in [docs/launch-checklist.md §2 and §3](../../docs/launch-checklist.md): onboard a creator with Stripe's test data, create a plan, pay with `4242…`, fail a renewal with `4000 0000 0000 0341` on a test clock, refund, dispute with `4000 0000 0000 0259`, cancel from the Billing Portal, and run the Telegram join, decline and removal checks. Keep `/admin` open for failed webhooks.

Useful while testing:

- Telegram webhook state: `node tools/set-telegram-webhook.js --info`.
- Stripe deliveries: Dashboard → Developers → Webhooks / Event destinations.
- Uptime monitor: `https://app.useflock.com/api/health?worker=1`. It fails if the worker has been silent for 2 minutes.

## 9. Launch day: switch to live mode

Test-mode Stripe objects (connected accounts, products, customers, subscriptions) don't exist in live mode, so the database must start empty.

1. **Backups first.** Before real money, add off-server database backups: either PR #1's pgBackRest → Cloudflare R2 setup, or move Postgres to a Coolify-managed database resource with scheduled S3 backups. Hetzner snapshots alone aren't enough.
2. Create the live destinations: `STRIPE_SECRET_KEY=sk_live_… pnpm stripe:webhooks --app-url https://app.useflock.com --create --live`.
3. In Coolify, replace `STRIPE_SECRET_KEY` (live restricted key) and the three `STRIPE_*_WEBHOOK_SECRET` values.
4. Wipe the database. Stop the app, then in the **postgres** terminal:

   ```bash
   psql -U "$POSTGRES_USER" -d flock -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;'
   ```

5. **Redeploy.** `migrate` recreates the schema. Run `node tools/deploy-check.js` again, then confirm the test-mode banner is gone.
6. In Stripe test mode, disable the test destinations so they stop retrying against an empty database.
7. Rotate `TELEGRAM_WEBHOOK_SECRET` and any secret that was ever pasted outside Coolify.

## 10. Later: a staging copy

When real creators depend on production, add a second Coolify application from the same repo and compose file, in a `staging` environment. Give it its own domain (`staging.useflock.com`), its own bot, and Stripe test keys. It gets its own Postgres volume automatically. It can share the server until load says otherwise.

## Troubleshooting

- **Deploy fails at once with `required variable … is missing`**: a `${VAR:?}` variable is empty. Set it in Coolify.
- **`Invalid Flock configuration`** in web or worker logs: a value has the wrong format (see `packages/core/src/config.ts`).
- **`migrate` exits 1**: read its logs. Web and worker don't start until it succeeds, so the previous version keeps serving only if Coolify kept it (compose deploys aren't zero-downtime).
- **`telegram-webhook` exits 1**: usually a bad bot token or an `APP_URL` that isn't public https yet. The app still runs. Fix it and redeploy, or run `node tools/set-telegram-webhook.js` from the worker terminal.
- **Build runs out of memory**: add swap (`fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`, plus an fstab entry), or resize the server.
