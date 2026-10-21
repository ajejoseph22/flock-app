# Security and Compliance

## 1. Threat model (summary)

| Asset | Threat | Control |
|---|---|---|
| Paid access | Unpaid user joins | Join-request links; approval only for Telegram IDs with an active entitlement; redirects never grant |
| Creator community | Another creator claims it | `my_chat_member` must come from a Telegram user with a pending request who is creator/admin of the chat; unique chat ID |
| Creator data | Cross-tenant read/write | Every creator query is scoped by `creator_id` derived from the session (`requireCreator()`); IDs from the client are only used together with that scope |
| Stripe accounts | Cross-tenant Stripe access | Stripe account ID only read from `merchant_accounts` joined through the session's creator; never from client input |
| Sessions | Theft/fixation | 256-bit random tokens, SHA-256 hashed at rest, HTTP-only/Secure/SameSite=Lax cookie, server-side revocation, 30-day expiry |
| Login | Link phishing | Confirm/"Not me" buttons, 10-minute single-use challenge, browser-bound secret, warning copy in the bot |
| Webhooks | Forgery/replay | Stripe signature on raw body with 5-minute tolerance; Telegram secret token (constant-time compare); event IDs deduplicated |
| Secrets | Leakage | Env only; never logged (Pino redaction); `.env*` git-ignored; no secrets in Stripe metadata |
| Availability | Abuse | Postgres-backed rate limits on auth and checkout endpoints; body size limits |

## 2. Authentication

- Login tokens: `crypto.randomBytes(32)` → base64url; DB stores `sha256(token)`. Deep link payload `l_<43 chars>` fits Telegram's 64-char `start` limit.
- Challenge lifecycle: `pending → claimed (/start by Telegram user X) → confirmed (callback by X) → consumed (browser)`, or `rejected` / `expired`. Each transition is a conditional `UPDATE … WHERE status = <expected>` so it can happen once.
- The browser secret is in an HTTP-only cookie scoped to the challenge; a different browser cannot consume the challenge.
- Sessions: `sessions.token_hash` unique; `expires_at` 30 days; logout deletes; expired rows purged daily.
- CSRF: mutations use Server Actions (Next.js checks `Origin` against `Host`) or route handlers that call `assertSameOrigin()`. Session cookie is `SameSite=Lax`.

## 3. Authorization

- `requireUser()` / `requireCreator()` in `apps/web/lib/auth.ts` are the only way pages and actions obtain identity.
- Services take `creatorId` as a parameter that callers derive from the session; services re-check ownership (`community.creator_id = creatorId`) before any write.
- Subscriber operations (status page, billing portal) check `user_id = session.user_id`.
- `/admin` requires the session user's Telegram ID to be in `ADMIN_TELEGRAM_USER_IDS`.
- No user-facing endpoint accepts Stripe IDs, prices or amounts for anything other than plan creation (where the amount is the creator's own input, validated by Zod).

## 4. Webhook security

- Stripe: `stripe.webhooks.constructEvent(rawBody, signature, secret)` for snapshot events, `stripe.parseEventNotification` for thin events. Connected-account events must carry `account` matching a known `merchant_accounts.stripe_account_id`; platform events must not carry `account`.
- Telegram: `setWebhook(secret_token=TELEGRAM_WEBHOOK_SECRET)`; route rejects mismatches with 401. `allowed_updates` restricts update types.
- Payload limits enforced before parsing. Invalid JSON → 400. Persisted before 200; processing errors never leak to the response.

## 5. Data protection & privacy

- Personal data stored: Telegram user ID, username, first/last name; Stripe customer/subscription IDs; creator contact email. No card data (Stripe-hosted Checkout and Portal; Flock is out of PCI scope beyond SAQ A).
- Raw webhook payloads retained 30 days, then pruned (retention job).
- Audit logs retained indefinitely (business records); analytics events contain IDs, not message content.
- Deletion requests: delete user row cascades sessions/challenges; subscription and audit records are retained for the creator's accounting (documented in the Privacy Policy draft).
- Logs: Pino with redaction of `authorization`, `cookie`, `stripe-signature`, `x-telegram-bot-api-secret-token`, `token`, `secret`, `password` paths.

## 6. Operational security

- Secrets managed in Railway variables; separate Stripe Sandbox (test) and live keys per environment.
- Least-privilege bot rights: `can_invite_users`, `can_restrict_members` only.
- Dependency updates via lockfile; `pnpm audit` in the launch checklist.
- Database: Railway Postgres daily backups; migrations are additive and run as a pre-deploy step.

## 7. Compliance notes and open questions

**Telegram.**
- The bot does not sell anything inside Telegram and never sends Checkout/Portal links. Payment happens on app.useflock.com. The bot's `/status` points users to the Flock account page by URL text for membership management.
- *Open question (founder/legal):* Telegram's rules require Stars for digital goods and services sold **in bots and Mini Apps**. Flock's storefront is an independent website, which is the model used by established services in this category, but Telegram can change its policies. Mitigation: keep the bot free of payment flows and plan a compliant Stars flow (P2).
- Bot must respond to `/paysupport` only if Stars are introduced; not applicable now.

**Stripe.**
- Creators are merchants of record on their own accounts (direct charges, Stripe-collected fees and losses). Flock must ensure Stripe's Connect platform terms are accepted and that the business categories of creators are permitted (review Stripe's restricted businesses list; e.g. some "investment signals" communities may be restricted).
- Creators are responsible for their own taxes (Stripe Tax can be enabled by them on their accounts).
- *Open question:* whether to require creators to accept Flock Terms of Service with an explicit checkbox before publishing (recommended; the draft Terms page exists, legal review required).

**Privacy.**
- Draft Terms and Privacy pages are placeholders marked "Draft — pending legal review". They must be reviewed before public launch (GDPR: Flock is processor for subscriber data on behalf of creators and controller for creator data).

## 8. Known residual risks

1. Login-link phishing (social engineering a user into confirming an attacker's challenge). Mitigated, not eliminated.
2. Telegram doesn't expose full member lists; users who joined the chat outside Flock are invisible to Flock and are never removed by it (by design).
3. A creator who is a chat admin (not owner) can connect the chat; the owner can always remove the bot.
4. Refund detection relies on `charge.refunded` events (and hourly reconciliation of subscription state); a missed refund event is not re-detected by reconciliation.
