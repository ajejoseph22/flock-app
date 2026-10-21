# User Stories

Format for P0 stories: **Actor · Objective · Value · Preconditions · Acceptance criteria · Failure scenarios · Tests.**
Test references point at files under `packages/*/src/**/*.test.ts` (unit), `tests/integration/` and `tests/e2e/`.

Implementation status is tracked in the final column of the index and in `launch-checklist.md`.

## Index

| ID | Area | Story | Pri | Status |
|---|---|---|---|---|
| US-01 | Creator auth | Sign in with Telegram | P0 | Implemented, tested (mocked) |
| US-02 | Creator auth | Sign out | P0 | Implemented, tested (mocked) |
| US-03 | Community | Create community | P0 | Implemented, tested |
| US-04 | Telegram | Connect private channel/group | P0 | Implemented, tested (mocked) |
| US-05 | Telegram | Detect lost bot permissions | P0 | Implemented, tested (mocked) |
| US-06 | Payments onboarding | Connect Stripe merchant | P0 | Implemented, tested (mocked) |
| US-07 | Plans | Create monthly plan | P0 | Implemented, tested (mocked) |
| US-08 | Plans | Change price / deactivate | P0 | Implemented, tested (mocked) |
| US-09 | Checkout | Publish and view membership page | P0 | Implemented, tested |
| US-10 | Identity | Subscriber links Telegram | P0 | Implemented, tested (mocked) |
| US-11 | Checkout | Subscribe via Stripe Checkout | P0 | Implemented, tested (mocked) |
| US-12 | Access | Receive access after payment | P0 | Implemented, tested (mocked) |
| US-13 | Access | Forwarded link doesn't admit others | P0 | Implemented, tested (mocked) |
| US-14 | Renewal | Renewal extends access | P0 | Implemented, tested (mocked) |
| US-15 | Renewal | Failed renewal grace then removal | P0 | Implemented, tested (mocked) |
| US-16 | Cancellation | Cancel at period end | P0 | Implemented, tested (mocked) |
| US-17 | Cancellation | Refund/dispute ends access | P0 | Implemented, tested (mocked) |
| US-18 | Access | Rejoin after paying again | P0 | Implemented, tested (mocked) |
| US-19 | Billing | Subscriber manages billing | P0 | Implemented, tested (mocked) |
| US-20 | Reporting | Creator dashboard | P0 | Implemented, tested |
| US-21 | Reporting | Members table and timeline | P0 | Implemented, tested |
| US-22 | Ops | Recover from outages | P0 | Implemented, tested (mocked) |
| US-23 | Ops | Bot commands | P0 | Implemented, tested (mocked) |
| US-24 | Ops | Operator sees failures | P1 | Implemented (basic) |
| US-25 | Billing | Creator pays Flock (Starter/Growth) | P1 | Implemented behind flag, not integrated |
| US-26 | Reporting | CSV export | P1 | Deferred |
| US-27 | Notifications | Creator email alerts | P1 | Deferred |
| US-28 | Plans | Multiple plans/communities | P1 | Deferred (schema ready) |
| US-29 | Support | Manually grant/remove a member | P1 | Deferred |
| US-30 | Payments | Telegram Stars subscriptions | P2 | Deferred |

"tested (mocked)" means automated tests ran against local provider mocks; live provider verification is listed in `launch-checklist.md`.

---

## Creator authentication

### US-01 Sign in with Telegram (P0)
- **Actor:** Creator (or subscriber).
- **Objective:** Sign in without a password.
- **Value:** Fast onboarding; verified Telegram ID from the first minute.
- **Preconditions:** User has Telegram; bot is reachable.
- **Acceptance criteria:**
  1. `/login` shows "Open Telegram" (deep link `t.me/<bot>?start=l_<token>`) and a QR code.
  2. Bot replies with "Confirm sign-in" / "Not me" buttons.
  3. After Confirm, the browser that started the challenge is signed in within ~3 s and redirected to `/dashboard` (or `returnTo`).
  4. Challenge expires after 10 min, works once, and is bound to the originating browser via an HTTP-only cookie.
- **Failure scenarios:** expired token ("link expired, start again"); token reused; "Not me" pressed; a different browser polls (no session); worker down (page keeps waiting, shows help after 30 s).
- **Tests:** `packages/core/src/services/auth.test.ts`, `tests/integration/auth.test.ts`, `tests/e2e/auth.spec.ts`.

### US-02 Sign out (P0)
- **Actor:** Any signed-in user. **Objective:** End the session. **Value:** Shared-device safety.
- **Preconditions:** Signed in.
- **Acceptance criteria:** Sign-out deletes the session row and cookie; protected pages redirect to `/login`.
- **Failure scenarios:** Stale cookie → treated as signed out.
- **Tests:** `tests/integration/auth.test.ts`, `tests/e2e/auth.spec.ts`.

## Community creation

### US-03 Create community (P0)
- **Actor:** Signed-in user. **Objective:** Create a community. **Value:** Container for chat, plan and page.
- **Preconditions:** Signed in; has no community (MVP limit 1).
- **Acceptance criteria:** Name 2–80 chars; slug unique `[a-z0-9-]{3,48}`, reserved words rejected; creator profile created implicitly; `community_created` analytics event; draft status.
- **Failure scenarios:** duplicate slug → field error; second community → limit message.
- **Tests:** `tests/integration/onboarding.test.ts`, `tests/e2e/membership.spec.ts`.

## Telegram channel connection

### US-04 Connect private channel or group (P0)
- **Actor:** Creator. **Objective:** Connect their chat. **Value:** Flock can manage access.
- **Preconditions:** Community exists; creator is owner/admin of the chat.
- **Acceptance criteria:**
  1. Creator picks channel/group; Flock creates a pending request (30 min) and shows an "Add bot as admin" deep link with rights `invite_users+restrict_members`.
  2. On `my_chat_member` (bot promoted) from the same Telegram user, Flock verifies the user is creator/admin, the bot has `can_invite_users` and `can_restrict_members`, and the chat is unclaimed.
  3. Stores numeric chat ID, type, title; page shows "Connected".
- **Failure scenarios:** bot added without rights → "needs attention" + exact missing right; promoted by someone without a request → ignored, DM explaining; chat already connected elsewhere → rejected; anonymous admin → instruct to turn off "Remain anonymous"; request expired.
- **Tests:** `tests/integration/telegram-connection.test.ts`, `tests/e2e/membership.spec.ts`.

### US-05 Detect lost bot permissions (P0)
- **Actor:** System. **Objective:** Notice bot removal/demotion. **Value:** Creator can fix it before members are affected.
- **Preconditions:** Chat connected.
- **Acceptance criteria:** `my_chat_member` with status `left`/`kicked`/`member` or missing rights sets chat `needs_attention` with reason; dashboard banner; access jobs keep retrying with backoff; "Re-check" restores status when fixed.
- **Failure scenarios:** missed update → reconciliation `getChatMember(bot)` detects it.
- **Tests:** `tests/integration/telegram-connection.test.ts`.

## Payment-provider onboarding

### US-06 Connect Stripe merchant (P0)
- **Actor:** Creator. **Objective:** Accept payments into their own Stripe account. **Value:** Creator owns funds and customer relationship.
- **Preconditions:** Community exists.
- **Acceptance criteria:** Creates an Accounts v2 account (merchant config, Stripe-collected fees/losses, full dashboard) once per creator (idempotent); redirects to Stripe-hosted onboarding; return URL re-fetches account; status shows capability status and outstanding requirements; expired link → refresh URL generates a new link for the same authenticated creator.
- **Failure scenarios:** country unsupported / capability `rejected`/`unsupported` → blocking error; requirements past due → payments paused message; return without finishing → "Continue onboarding".
- **Tests:** `tests/integration/merchant-plans-checkout.test.ts`, `tests/e2e/membership.spec.ts`.

## Membership-plan creation

### US-07 Create monthly plan (P0)
- **Actor:** Creator. **Objective:** Define price. **Value:** Sell access.
- **Preconditions:** Merchant connected (account exists; readiness needed to publish).
- **Acceptance criteria:** Name, description, amount (≥ 1.00, ≤ 10,000.00), currency (USD default); server creates Product + monthly Price on the connected account with idempotency keys; integer minor units stored.
- **Failure scenarios:** Stripe error → plan not created, message shown; duplicate submission → one plan.
- **Tests:** `packages/core/src/domain/money.test.ts`, `tests/integration/merchant-plans-checkout.test.ts`.

### US-08 Change price / deactivate (P0)
- **Acceptance criteria:** New amount creates a new Price (old Price archived for new sales); existing subscriptions untouched; deactivating the only active plan unpublishes checkout (page shows "not accepting new members").
- **Tests:** `tests/integration/merchant-plans-checkout.test.ts`.

## Public membership checkout

### US-09 Publish and view membership page (P0)
- **Acceptance criteria:** Publish requires connected chat, ready merchant, active plan; `/join/<slug>` renders name, description, benefits, price, cancellation terms; unpublished → 404; works at 360 px.
- **Tests:** `tests/e2e/membership.spec.ts`.

### US-11 Subscribe via Stripe Checkout (P0)
- **Actor:** Subscriber. **Objective:** Pay. **Value:** Access.
- **Preconditions:** Signed in with Telegram; page published; no active entitlement for this community.
- **Acceptance criteria:** Server creates checkout intent + Checkout Session (subscription mode) on the connected account with DB-sourced price; metadata only contains Flock IDs; success URL leads to status page which shows "Confirming payment" until entitlement is active.
- **Failure scenarios:** already subscribed → status page; merchant not ready → error; checkout canceled → page with retry; payment failed in Checkout → stays on Stripe; session expired → intent expired via webhook.
- **Tests:** `tests/integration/merchant-plans-checkout.test.ts`, `tests/e2e/membership.spec.ts`.

## Subscriber Telegram identity verification

### US-10 Subscriber links Telegram (P0)
- Same mechanism as US-01, started from the membership page, returns to the page.
- **Acceptance criteria:** The page shows the linked Telegram name/username after confirmation; "Not you? Switch account" signs out.
- **Tests:** `tests/e2e/membership.spec.ts`.

## Automated access management

### US-12 Receive access after payment (P0)
- **Actor:** System/subscriber.
- **Acceptance criteria:** After Stripe-confirmed payment, entitlement `active`, grant `invited`, bot DMs a join-request link, status page shows it; join request approved; grant `member`.
- **Failure scenarios:** bot can't DM (user blocked bot) → link still on status page and via `/status`; chat permission lost → grant `failed`, retried, creator alerted; Telegram outage → retries with backoff.
- **Tests:** `tests/integration/access-lifecycle.test.ts`, `tests/e2e/membership.spec.ts`.

### US-13 Forwarded link doesn't admit others (P0)
- **Acceptance criteria:** Join request from a Telegram user without an active entitlement is declined.
- **Tests:** `tests/integration/access-lifecycle.test.ts`.

## Subscription renewal

### US-14 Renewal extends access (P0)
- **Acceptance criteria:** `invoice.paid` for the next period → `paid_through` moves forward; no Telegram action.
- **Tests:** `packages/core/src/domain/eligibility.test.ts`, `tests/integration/access-lifecycle.test.ts`.

### US-15 Failed renewal: grace then removal (P0)
- **Acceptance criteria:** `past_due` keeps access until `paid_through + 48h`; then removal; recovery payment during grace keeps member in; after removal, payment re-grants.
- **Tests:** `eligibility.test.ts`, `access-lifecycle.test.ts`.

## Cancellation and expiration

### US-16 Cancel at period end (P0)
- **Acceptance criteria:** `cancel_at_period_end` → access until `paid_through`; status page/account show "Ends on <date>"; at end, removal.
- **Tests:** `eligibility.test.ts`, `access-lifecycle.test.ts`.

### US-17 Refund or dispute ends access (P0)
- **Acceptance criteria:** Full refund of the invoice covering the current period → access ends now; dispute opened → access suspended; dispute won → restored.
- **Tests:** `eligibility.test.ts`, `tests/integration/stripe-webhooks.test.ts`.

### US-18 Rejoin after paying again (P0)
- **Acceptance criteria:** Removed user subscribes again → new entitlement → new invite → approved (no permanent ban).
- **Tests:** `access-lifecycle.test.ts`.

## Subscriber billing

### US-19 Manage billing (P0)
- **Acceptance criteria:** `/account` lists memberships with status and renewal/end date; "Manage billing" creates a Billing Portal session on the correct connected account for the session user's own customer; portal allows card update and cancel at period end.
- **Failure scenarios:** user has no customer on that merchant → 404; another user's membership ID → 404.
- **Tests:** `tests/integration/merchant-plans-checkout.test.ts`, `tests/e2e/membership.spec.ts`.

## Creator reporting

### US-20 Dashboard (P0)
- **Acceptance criteria:** Active members, active subscriptions, MRR (sum of active subscription amounts normalised to monthly, per currency), recent payments and cancellations, attention list, setup status, empty states.
- **Tests:** `tests/integration/reporting.test.ts`, `tests/e2e/membership.spec.ts`.

### US-21 Members table and timeline (P0)
- **Acceptance criteria:** Search by name/username/Telegram ID; sort by joined/renewal/status; detail page shows timeline from audit log; strictly scoped to creator's community.
- **Tests:** `reporting.test.ts`, `tests/e2e/membership.spec.ts`.

## Operational support

### US-22 Recover from outages (P0)
- **Acceptance criteria:** Webhooks persisted before 200; jobs survive restarts; stale locks recovered; reconciliation re-syncs subscriptions and repairs grants; expiry sweep catches missed revocations.
- **Tests:** `tests/integration/jobs.test.ts`, `tests/integration/reconciliation.test.ts`.

### US-23 Bot commands (P0)
- **Acceptance criteria:** `/start` welcome, `/help`, `/status` (memberships + re-issue invite if entitled and not a member), `/support`; no payment links.
- **Tests:** `tests/integration/bot-commands.test.ts`.

## P1/P2 stories (brief)

- **US-24** Operator sees failed jobs/webhooks on `/admin` (basic version shipped).
- **US-25** Creator subscribes to Starter/Growth via platform Checkout; portal for invoices. Implemented behind `PLATFORM_BILLING_ENABLED`.
- **US-26** CSV export of members. **US-27** Email notifications for failed access/merchant issues. **US-28** Multiple plans/communities in UI. **US-29** Manual grant (comp) and manual remove with audit reason. **US-30** Telegram Stars subscription links as an alternative checkout.
