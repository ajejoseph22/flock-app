# Payment and Access Lifecycle

Three layers, each with its own state, each derived from the one above:

```
Stripe subscription (authoritative billing)  ──sync──▶  subscriptions row (cached + paid_through)
                                                           │ evaluateEntitlement()  (pure, core/domain/eligibility.ts)
                                                           ▼
                                                  entitlements row (active / ended, access_ends_at)
                                                           │ desired = any active entitlement for (user, community)
                                                           ▼
                                                  telegram_access_grants row (Telegram reality)
```

## 1. Sync: Stripe → `subscriptions`

Triggered by any connected-account event that references a subscription (directly, via invoice parent, via checkout session, or via charge → invoice payment → invoice), and by hourly reconciliation.

1. Resolve merchant by `event.account`. Unknown account → event `ignored`.
2. `GET /v1/subscriptions/:id` (Stripe-Account) and `GET /v1/invoices?subscription=:id&status=paid&limit=12`.
3. Resolve Flock context from `subscription.metadata.flock_checkout_intent_id` (must belong to the same merchant) or from an existing row. Subscriptions not created by Flock are ignored.
4. Verify `subscription.customer` equals the intent's subscriber customer.
5. Under `pg_advisory_xact_lock(hash(merchant, subscription))`:
   - `paid_through = max(line.period.end)` over paid invoices whose IDs are not in `excluded_invoice_ids` (refunded/disputed).
   - Upsert status, `cancel_at_period_end`, `canceled_at`, `ended_at`, current period (from subscription item), amount/currency.
   - Evaluate eligibility → upsert entitlement → if `status` or `access_ends_at` changed: audit log + analytics + enqueue `access.reconcile`.

Because step 2 always reads current Stripe state, event order and duplicates don't matter.

## 2. Eligibility rules (`evaluateEntitlement`)

Inputs: `status`, `paidThrough`, `disputed`, `now`, `graceMs`.

| Stripe status | Grace applies | Eligible while |
|---|---|---|
| `active`, `trialing` | yes | `now < paid_through + grace` |
| `past_due` | yes | `now < paid_through + grace` |
| `canceled` | no | `now < paid_through` |
| `unpaid`, `paused` | no | `now < paid_through` |
| `incomplete`, `incomplete_expired` | no | never (no paid invoice) |
| any, `disputed = true` | — | never |
| any, `paid_through = null` | — | never |

Reason codes: `active`, `grace_period`, `canceled_until_period_end`, `payment_failed`, `never_paid`, `expired`, `disputed`, `refunded`.

Why grace is computed from `paid_through` and not from Stripe's period dates: when a renewal fails Stripe has already advanced the subscription's current period; the paid-through date is the true end of what the subscriber paid for.

## 3. Entitlement state machine

```
             sync: eligible                     sweep/sync: not eligible
  (none) ─────────────────────▶ active ──────────────────────────────▶ ended
                                  ▲                                     │
                                  └──────────── sync: eligible ─────────┘
                                  (late payment, dispute won, renewal recovered)
```
`access_ends_at` is recomputed on every sync. The expiry sweep re-evaluates `active` rows with `access_ends_at <= now()`.

## 4. Access grant state machine (`telegram_access_grants`, one per user × community)

```
           reconcile: desired                 invite DM / status page          join request approved
  (none) ───────────────────▶ pending ──issue_invite──▶ invited ─────────────────────────▶ member
                                 │                         │                                 │
                                 │ error                   │ reconcile: not desired          │ chat_member: left
                                 ▼                         ▼                                 ▼
                               failed ◀───── error ───── revoking ◀── reconcile: not desired ── left
                                 │                         │
                                 └── retry/reconcile ──────┴──▶ revoked ──(desired again)──▶ pending
```

Rules enforced in `core/services/access.ts`:
- **Desired** is computed fresh inside every job, never carried in the job payload.
- **Grant:** if the user is already a member/admin/owner, go straight to `member`. If the user is `kicked` (banned) and Flock didn't ban them, don't unban: mark `failed` with `banned_by_admin` and surface to the creator.
- **Join request:** approve iff desired; otherwise decline. `USER_ALREADY_PARTICIPANT` counts as success.
- **Revoke:** skip `creator`/`administrator` (recorded as `revoked` with note `admin_not_removed`); `left` → `revoked`; otherwise `banChatMember` then `unbanChatMember(only_if_banned=true)`. Any outstanding invite link is revoked.
- **Retry:** 429 → `retry_after`; 5xx/network → backoff; 400/403 permission errors → chat `needs_attention`, job retried with backoff, grant shows last error.

## 5. Failure-handling matrix

| Scenario | Behaviour |
|---|---|
| Failed initial payment | Checkout keeps user on Stripe; if a subscription ends `incomplete`/`incomplete_expired` → never eligible; status page shows "Payment not completed" |
| Failed recurring payment | `past_due`; access until `paid_through + 48h`; then revoked; later payment re-grants |
| Cancel at period end | Access until `paid_through`, then revoked |
| Immediate cancellation (no refund) | Access until `paid_through` (they paid for it); creator can refund to cut access now |
| Expiration (`unpaid`, `incomplete_expired`, canceled after period) | Revoked when `access_ends_at` passes |
| Payment OK, Telegram delivery fails | Entitlement active; grant `failed`/`pending`; retries; status page + `/status` show link once created; creator attention list |
| Duplicate webhook | `webhook_events (provider, external_id)` unique → 200 no-op |
| Out-of-order webhooks | Sync reads current Stripe state |
| User leaves voluntarily | `chat_member` → grant `left`; still entitled → `/status` re-issues link |
| Creator removes bot | `my_chat_member` → chat `needs_attention`; jobs back off; revocations resume when fixed |
| Merchant restricted | Merchant status updated from thin event; new checkouts blocked; existing subscriptions follow Stripe state |
| Refund (full, current period) | Invoice excluded → `paid_through` drops → access ends now |
| Dispute opened | `disputed = true` → access ends now; dispute won → restored |
| Telegram API outage | Jobs retry with backoff up to ~24 h, then `dead`; reconciliation re-creates them |
| Worker outage | Webhooks still persisted by web; jobs and sweeps catch up on restart; `access_ends_at` sweeps are idempotent |
| Missed Stripe webhook | Hourly reconciliation re-syncs |

## 6. Checkout intents

`created → open (session created) → completed (checkout.session.completed) | expired (checkout.session.expired)`. An intent stores the snapshot of creator, community, plan, price, user, merchant account and Stripe account ID. Only Flock IDs go into Stripe metadata.

## 7. What never grants access

- The `success_url` redirect or any query parameter.
- A client-supplied price, plan, account or user ID.
- A Stripe event payload on its own (we always re-fetch).
- A Telegram username.
