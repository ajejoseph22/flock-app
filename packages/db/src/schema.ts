import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const ts = (name: string) => timestamp(name, { withTimezone: true });
/** Telegram IDs exceed 2^31 but have at most 52 significant bits, so JS numbers are exact. */
const tgId = (name: string) => bigint(name, { mode: "number" });

// ─── Identity ────────────────────────────────────────────────────────────────

/** A person, identified by exactly one verified numeric Telegram user ID. */
export const users = pgTable("users", {
  id: id(),
  telegramUserId: tgId("telegram_user_id").notNull().unique(),
  telegramUsername: text("telegram_username"),
  firstName: text("first_name").notNull().default(""),
  lastName: text("last_name"),
  /** True once the user has a private chat with the bot (needed for DMs). */
  botChatStarted: boolean("bot_chat_started").notNull().default(false),
  /** Set when Telegram reports the user blocked the bot. */
  botBlockedAt: ts("bot_blocked_at"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: createdAt(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

export const authChallengeStatus = pgEnum("auth_challenge_status", [
  "pending",
  "claimed",
  "confirmed",
  "consumed",
  "rejected",
  "expired",
]);

/** One-time Telegram deep-link sign-in challenge. Only hashes are stored. */
export const authChallenges = pgTable(
  "auth_challenges",
  {
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    browserSecretHash: text("browser_secret_hash").notNull(),
    status: authChallengeStatus("status").notNull().default("pending"),
    claimedByTelegramUserId: tgId("claimed_by_telegram_user_id"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    returnTo: text("return_to"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
    confirmedAt: ts("confirmed_at"),
    consumedAt: ts("consumed_at"),
  },
  (t) => [index("auth_challenges_expires_idx").on(t.expiresAt)],
);

// ─── Creators & merchants ────────────────────────────────────────────────────

export const platformPlan = pgEnum("platform_plan", ["beta", "starter", "growth"]);

export const creators = pgTable("creators", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "restrict" }),
  displayName: text("display_name").notNull(),
  contactEmail: text("contact_email"),
  platformPlan: platformPlan("platform_plan").notNull().default("beta"),
  /** Flock's own Stripe customer for SaaS billing (platform account). */
  platformStripeCustomerId: text("platform_stripe_customer_id").unique(),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Flock SaaS subscriptions (creator pays Flock), on the platform Stripe account. */
export const platformSubscriptions = pgTable(
  "platform_subscriptions",
  {
    id: id(),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id, { onDelete: "restrict" }),
    stripeSubscriptionId: text("stripe_subscription_id").notNull().unique(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    planKey: platformPlan("plan_key").notNull(),
    status: text("status").notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    currentPeriodEnd: ts("current_period_end"),
    lastSyncedAt: ts("last_synced_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("platform_subscriptions_creator_idx").on(t.creatorId)],
);

/** The creator's Stripe connected account (Accounts v2, merchant configuration). */
export const merchantAccounts = pgTable("merchant_accounts", {
  id: id(),
  creatorId: uuid("creator_id")
    .notNull()
    .unique()
    .references(() => creators.id, { onDelete: "restrict" }),
  stripeAccountId: text("stripe_account_id").notNull().unique(),
  livemode: boolean("livemode").notNull(),
  /** v2 `configuration.merchant.capabilities.card_payments.status`, or null before first sync. */
  cardPaymentsStatus: text("card_payments_status"),
  /** v2 `requirements.summary.minimum_deadline.status` (currently_due | eventually_due | past_due) or null. */
  requirementsStatus: text("requirements_status"),
  /** Human-readable outstanding requirement descriptions for display. */
  requirements: jsonb("requirements").$type<MerchantRequirement[]>().notNull().default([]),
  displayName: text("display_name"),
  country: text("country"),
  defaultCurrency: char("default_currency", { length: 3 }),
  /** Billing portal configuration created on the connected account. */
  portalConfigurationId: text("portal_configuration_id"),
  disconnectedAt: ts("disconnected_at"),
  lastSyncedAt: ts("last_synced_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type MerchantRequirement = { description: string; awaitingActionFrom: string; deadlineStatus: string | null };

// ─── Communities & Telegram chats ────────────────────────────────────────────

export const communityStatus = pgEnum("community_status", ["draft", "published", "archived"]);

export const communities = pgTable(
  "communities",
  {
    id: id(),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description").notNull().default(""),
    benefits: jsonb("benefits").$type<string[]>().notNull().default([]),
    avatarUrl: text("avatar_url"),
    coverUrl: text("cover_url"),
    supportContact: text("support_contact"),
    status: communityStatus("status").notNull().default("draft"),
    publishedAt: ts("published_at"),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("communities_creator_idx").on(t.creatorId)],
);

export const chatType = pgEnum("chat_type", ["channel", "supergroup", "group"]);
export const chatConnectionStatus = pgEnum("chat_connection_status", ["connected", "needs_attention"]);

/** The Telegram chat connected to a community. A chat can belong to only one community. */
export const telegramChats = pgTable("telegram_chats", {
  id: id(),
  communityId: uuid("community_id")
    .notNull()
    .unique()
    .references(() => communities.id, { onDelete: "cascade" }),
  telegramChatId: tgId("telegram_chat_id").notNull().unique(),
  chatType: chatType("chat_type").notNull(),
  title: text("title").notNull(),
  username: text("username"),
  status: chatConnectionStatus("status").notNull().default("connected"),
  statusReason: text("status_reason"),
  botCanInviteUsers: boolean("bot_can_invite_users").notNull().default(false),
  botCanRestrictMembers: boolean("bot_can_restrict_members").notNull().default(false),
  connectedByUserId: uuid("connected_by_user_id")
    .notNull()
    .references(() => users.id),
  connectedAt: ts("connected_at").notNull().defaultNow(),
  lastVerifiedAt: ts("last_verified_at").notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const connectionRequestStatus = pgEnum("connection_request_status", [
  "pending",
  "completed",
  "failed",
  "expired",
  "canceled",
]);

/** A creator's intent to connect a chat; matched against authenticated my_chat_member updates. */
export const chatConnectionRequests = pgTable(
  "chat_connection_requests",
  {
    id: id(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "cascade" }),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id),
    telegramUserId: tgId("telegram_user_id").notNull(),
    chatType: text("chat_type").notNull(),
    status: connectionRequestStatus("status").notNull().default("pending"),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    telegramChatId: tgId("telegram_chat_id"),
    chatTitle: text("chat_title"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("chat_connection_requests_tg_user_idx").on(t.telegramUserId, t.status)],
);

// ─── Plans & prices ──────────────────────────────────────────────────────────

export const planStatus = pgEnum("plan_status", ["active", "inactive"]);

export const membershipPlans = pgTable(
  "membership_plans",
  {
    id: id(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "restrict" }),
    merchantAccountId: uuid("merchant_account_id")
      .notNull()
      .references(() => merchantAccounts.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    status: planStatus("status").notNull().default("active"),
    stripeProductId: text("stripe_product_id"),
    /** The price new checkouts use. */
    currentPriceId: uuid("current_price_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("membership_plans_community_idx").on(t.communityId)],
);

/** Immutable price versions. Stripe Prices can't change amount; a change creates a new row. */
export const planPrices = pgTable(
  "plan_prices",
  {
    id: id(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => membershipPlans.id, { onDelete: "restrict" }),
    amountMinor: integer("amount_minor").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    interval: text("interval").notNull().default("month"),
    intervalCount: integer("interval_count").notNull().default(1),
    stripePriceId: text("stripe_price_id"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    index("plan_prices_plan_idx").on(t.planId),
    uniqueIndex("plan_prices_stripe_price_uq").on(t.stripePriceId),
    check("plan_prices_amount_positive", sql`${t.amountMinor} > 0`),
    check("plan_prices_currency_lower", sql`${t.currency} = lower(${t.currency})`),
  ],
);

// ─── Subscribers, checkout, subscriptions ───────────────────────────────────

/** A user's Stripe Customer on a specific connected account. */
export const subscriberCustomers = pgTable(
  "subscriber_customers",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    merchantAccountId: uuid("merchant_account_id")
      .notNull()
      .references(() => merchantAccounts.id, { onDelete: "restrict" }),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("subscriber_customers_user_merchant_uq").on(t.merchantAccountId, t.userId),
    uniqueIndex("subscriber_customers_stripe_uq").on(t.merchantAccountId, t.stripeCustomerId),
  ],
);

export const checkoutIntentStatus = pgEnum("checkout_intent_status", [
  "created",
  "open",
  "completed",
  "expired",
  "failed",
]);

export const checkoutIntents = pgTable(
  "checkout_intents",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id, { onDelete: "restrict" }),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => membershipPlans.id, { onDelete: "restrict" }),
    planPriceId: uuid("plan_price_id")
      .notNull()
      .references(() => planPrices.id, { onDelete: "restrict" }),
    merchantAccountId: uuid("merchant_account_id")
      .notNull()
      .references(() => merchantAccounts.id, { onDelete: "restrict" }),
    subscriberCustomerId: uuid("subscriber_customer_id")
      .notNull()
      .references(() => subscriberCustomers.id, { onDelete: "restrict" }),
    /** Snapshot of the connected account the session was created on. */
    stripeAccountId: text("stripe_account_id").notNull(),
    stripeCheckoutSessionId: text("stripe_checkout_session_id").unique(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    status: checkoutIntentStatus("status").notNull().default("created"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: ts("completed_at"),
  },
  (t) => [index("checkout_intents_user_idx").on(t.userId, t.communityId)],
);

/** Local cache of a Stripe subscription on a connected account, plus derived paid-through. */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    merchantAccountId: uuid("merchant_account_id")
      .notNull()
      .references(() => merchantAccounts.id, { onDelete: "restrict" }),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => membershipPlans.id, { onDelete: "restrict" }),
    planPriceId: uuid("plan_price_id").references(() => planPrices.id, { onDelete: "restrict" }),
    subscriberCustomerId: uuid("subscriber_customer_id")
      .notNull()
      .references(() => subscriberCustomers.id, { onDelete: "restrict" }),
    checkoutIntentId: uuid("checkout_intent_id").references(() => checkoutIntents.id),
    status: text("status").notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    cancelAt: ts("cancel_at"),
    canceledAt: ts("canceled_at"),
    endedAt: ts("ended_at"),
    currentPeriodStart: ts("current_period_start"),
    currentPeriodEnd: ts("current_period_end"),
    /** End of the latest period covered by a paid, non-refunded, non-disputed invoice. */
    paidThrough: ts("paid_through"),
    /** Invoices whose period no longer counts (full refund or dispute). */
    excludedInvoiceIds: jsonb("excluded_invoice_ids").$type<string[]>().notNull().default([]),
    /** True when the most recent paid invoice was fully refunded; such periods never get grace. */
    latestInvoiceRefunded: boolean("latest_invoice_refunded").notNull().default(false),
    /** Open disputes (charge/dispute IDs). Any open dispute suspends access. */
    openDisputeIds: jsonb("open_dispute_ids").$type<string[]>().notNull().default([]),
    amountMinor: integer("amount_minor").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    stripeCreatedAt: ts("stripe_created_at"),
    lastSyncedAt: ts("last_synced_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("subscriptions_merchant_stripe_uq").on(t.merchantAccountId, t.stripeSubscriptionId),
    index("subscriptions_community_idx").on(t.communityId, t.status),
    index("subscriptions_user_idx").on(t.userId),
    index("subscriptions_synced_idx").on(t.lastSyncedAt),
  ],
);

/** Paid/attempted invoices for connected-account subscriptions (creator revenue, never Flock's). */
export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "restrict" }),
    merchantAccountId: uuid("merchant_account_id")
      .notNull()
      .references(() => merchantAccounts.id, { onDelete: "restrict" }),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    stripeInvoiceId: text("stripe_invoice_id").notNull(),
    status: text("status").notNull(),
    amountPaidMinor: integer("amount_paid_minor").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    periodEnd: ts("period_end"),
    paidAt: ts("paid_at"),
    refunded: boolean("refunded").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("invoices_merchant_stripe_uq").on(t.merchantAccountId, t.stripeInvoiceId),
    index("invoices_community_paid_idx").on(t.communityId, t.paidAt),
  ],
);

export const entitlementStatus = pgEnum("entitlement_status", ["active", "ended"]);

/** Authoritative "may this user be in this community" state, one per subscription. */
export const entitlements = pgTable(
  "entitlements",
  {
    id: id(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .unique()
      .references(() => subscriptions.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "restrict" }),
    status: entitlementStatus("status").notNull(),
    reason: text("reason").notNull(),
    accessEndsAt: ts("access_ends_at"),
    activatedAt: ts("activated_at"),
    endedAt: ts("ended_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("entitlements_user_community_idx").on(t.userId, t.communityId, t.status),
    index("entitlements_due_idx").on(t.status, t.accessEndsAt),
  ],
);

export const grantState = pgEnum("grant_state", [
  "pending",
  "invited",
  "member",
  "left",
  "revoking",
  "revoked",
  "failed",
]);

/** Telegram-side access for a user in a community's chat. One per (user, community). */
export const telegramAccessGrants = pgTable(
  "telegram_access_grants",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id, { onDelete: "restrict" }),
    state: grantState("state").notNull().default("pending"),
    /** What the grant should be converging to; set by reconcile. */
    desired: boolean("desired").notNull().default(true),
    inviteLink: text("invite_link"),
    inviteLinkExpiresAt: ts("invite_link_expires_at"),
    joinedAt: ts("joined_at"),
    revokedAt: ts("revoked_at"),
    lastError: text("last_error"),
    lastErrorCode: text("last_error_code"),
    note: text("note"),
    lastCheckedAt: ts("last_checked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("telegram_access_grants_user_community_uq").on(t.userId, t.communityId),
    index("telegram_access_grants_community_state_idx").on(t.communityId, t.state),
  ],
);

// ─── Infrastructure ──────────────────────────────────────────────────────────

export const webhookProvider = pgEnum("webhook_provider", [
  "telegram",
  "stripe_connect",
  "stripe_platform",
  "stripe_accounts",
]);
export const webhookEventStatus = pgEnum("webhook_event_status", ["pending", "processed", "ignored", "failed"]);

/** Every accepted provider event, deduplicated by provider event ID. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    provider: webhookProvider("provider").notNull(),
    externalId: text("external_id").notNull(),
    type: text("type").notNull(),
    stripeAccountId: text("stripe_account_id"),
    payload: jsonb("payload").$type<unknown>().notNull(),
    status: webhookEventStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
  },
  (t) => [
    uniqueIndex("webhook_events_provider_external_uq").on(t.provider, t.externalId),
    index("webhook_events_status_idx").on(t.status, t.receivedAt),
  ],
);

export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "failed", "dead"]);

/** Durable job queue. Claimed with FOR UPDATE SKIP LOCKED. */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatus("status").notNull().default("queued"),
    /** At most one *queued* job per dedupe key. Running jobs don't block a fresh enqueue, so no state change is lost. */
    dedupeKey: text("dedupe_key"),
    runAt: ts("run_at").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(10),
    lockedAt: ts("locked_at"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("jobs_claim_idx").on(t.status, t.runAt),
    uniqueIndex("jobs_dedupe_active_uq")
      .on(t.dedupeKey)
      .where(sql`${t.status} = 'queued' and ${t.dedupeKey} is not null`),
  ],
);

/** Append-only trail of access, billing and configuration changes. */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    actorType: text("actor_type").notNull(), // user | system | stripe | telegram
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    creatorId: uuid("creator_id").references(() => creators.id, { onDelete: "set null" }),
    communityId: uuid("community_id").references(() => communities.id, { onDelete: "set null" }),
    subjectUserId: uuid("subject_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_community_subject_idx").on(t.communityId, t.subjectUserId, t.createdAt),
    index("audit_logs_creator_idx").on(t.creatorId, t.createdAt),
  ],
);

/** First-party product analytics. */
export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: id(),
    name: text("name").notNull(),
    userId: uuid("user_id"),
    creatorId: uuid("creator_id"),
    communityId: uuid("community_id"),
    properties: jsonb("properties").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("analytics_events_name_idx").on(t.name, t.createdAt)],
);

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: ts("window_start").notNull(),
  count: integer("count").notNull(),
});

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  startedAt: ts("started_at").notNull(),
  lastBeatAt: ts("last_beat_at").notNull(),
  version: text("version"),
});
