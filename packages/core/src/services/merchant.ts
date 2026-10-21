import { creators, merchantAccounts, type DbOrTx } from "@flock/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ANALYTICS } from "../analytics-events";
import type { Deps } from "../deps";
import { AppError, NotFoundError } from "../errors";
import { audit, track } from "./audit";

type MerchantRow = typeof merchantAccounts.$inferSelect;

/** Paid plans may go live only when Stripe reports card payments active (PAY-3). */
export function isMerchantReady(m: Pick<MerchantRow, "cardPaymentsStatus" | "disconnectedAt">): boolean {
  return m.cardPaymentsStatus === "active" && !m.disconnectedAt;
}

export type MerchantDisplayState = "not_connected" | "onboarding" | "pending_review" | "ready" | "restricted" | "rejected";

export function merchantDisplayState(m: MerchantRow | null): MerchantDisplayState {
  if (!m || m.disconnectedAt) return "not_connected";
  switch (m.cardPaymentsStatus) {
    case "active":
      return "ready";
    case "rejected":
    case "unsupported":
      return "rejected";
    case "restricted":
      return m.requirements.some((r) => r.awaitingActionFrom === "user") ? "onboarding" : "restricted";
    case "pending":
      return m.requirements.some((r) => r.awaitingActionFrom === "user") ? "onboarding" : "pending_review";
    default:
      return "onboarding";
  }
}

export async function getMerchantForCreator(db: DbOrTx, creatorId: string) {
  const [m] = await db.select().from(merchantAccounts).where(eq(merchantAccounts.creatorId, creatorId)).limit(1);
  return m ?? null;
}

const OnboardingInput = z.object({
  contactEmail: z.email("Enter a valid email").max(200),
});

function onboardingUrls(appUrl: string) {
  return { refreshUrl: `${appUrl}/api/stripe/connect/refresh`, returnUrl: `${appUrl}/api/stripe/connect/return` };
}

/** Create the creator's Accounts v2 account (once) and return a fresh Stripe-hosted onboarding URL. */
export async function startMerchantOnboarding(deps: Deps, creatorId: string, actorUserId: string, raw: unknown): Promise<string> {
  const { contactEmail } = OnboardingInput.parse(raw);
  const [creator] = await deps.db.select().from(creators).where(eq(creators.id, creatorId)).limit(1);
  if (!creator) throw new NotFoundError();
  let merchant = await getMerchantForCreator(deps.db, creatorId);

  if (!merchant) {
    const account = await deps.stripe.createMerchantAccount(
      { displayName: creator.displayName, contactEmail, defaultCurrency: "usd", metadata: { flock_creator_id: creatorId } },
      `flock-merchant-create:${creatorId}`,
    );
    const inserted = await deps.db.transaction(async (tx) => {
      await tx.update(creators).set({ contactEmail }).where(eq(creators.id, creatorId));
      const [row] = await tx
        .insert(merchantAccounts)
        .values({
          creatorId,
          stripeAccountId: account.id,
          livemode: account.livemode,
          cardPaymentsStatus: account.cardPaymentsStatus,
          requirementsStatus: account.requirementsStatus,
          requirements: account.requirements,
          displayName: account.displayName,
          country: account.country,
          defaultCurrency: account.defaultCurrency,
          lastSyncedAt: deps.now(),
        })
        .onConflictDoNothing({ target: merchantAccounts.creatorId })
        .returning();
      await audit(tx, { actorType: "user", actorUserId, creatorId, action: "stripe.account_created", details: { stripeAccountId: account.id } });
      return row;
    });
    merchant = inserted ?? (await getMerchantForCreator(deps.db, creatorId));
    if (!merchant) throw new Error("merchant insert race");
  } else if (merchant.disconnectedAt) {
    await deps.db.update(merchantAccounts).set({ disconnectedAt: null }).where(eq(merchantAccounts.id, merchant.id));
  }

  const link = await deps.stripe.createOnboardingLink(merchant.stripeAccountId, onboardingUrls(deps.config.appUrl));
  return link.url;
}

/** For the refresh URL (expired/used link): new link for the authenticated creator's own account. */
export async function createFreshOnboardingLink(deps: Deps, creatorId: string): Promise<string> {
  const merchant = await getMerchantForCreator(deps.db, creatorId);
  if (!merchant) throw new AppError("no_merchant", "Start Stripe onboarding from your dashboard.");
  const link = await deps.stripe.createOnboardingLink(merchant.stripeAccountId, onboardingUrls(deps.config.appUrl));
  return link.url;
}

/** Re-read the account from Stripe. Safe to call any time (webhooks, return URL, reconciliation). */
export async function refreshMerchant(deps: Pick<Deps, "db" | "stripe" | "now">, stripeAccountId: string) {
  const [merchant] = await deps.db.select().from(merchantAccounts).where(eq(merchantAccounts.stripeAccountId, stripeAccountId)).limit(1);
  if (!merchant) return null;
  const account = await deps.stripe.retrieveMerchantAccount(stripeAccountId);
  const wasReady = isMerchantReady(merchant);
  const [updated] = await deps.db
    .update(merchantAccounts)
    .set({
      cardPaymentsStatus: account.cardPaymentsStatus,
      requirementsStatus: account.requirementsStatus,
      requirements: account.requirements,
      displayName: account.displayName,
      country: account.country,
      defaultCurrency: account.defaultCurrency,
      lastSyncedAt: deps.now(),
    })
    .where(eq(merchantAccounts.id, merchant.id))
    .returning();
  if (!updated) return null;
  const nowReady = isMerchantReady(updated);
  if (wasReady !== nowReady || merchant.cardPaymentsStatus !== updated.cardPaymentsStatus) {
    await audit(deps.db, {
      actorType: "stripe",
      creatorId: merchant.creatorId,
      action: nowReady ? "stripe.account_ready" : "stripe.account_status_changed",
      details: { cardPayments: updated.cardPaymentsStatus, requirements: updated.requirementsStatus },
    });
    if (nowReady && !wasReady) await track(deps.db, ANALYTICS.stripeConnected, { creatorId: merchant.creatorId });
  }
  return updated;
}

/** Billing-portal configuration on the connected account, created lazily once. */
export async function ensurePortalConfiguration(deps: Pick<Deps, "db" | "stripe" | "config">, merchant: MerchantRow, headline: string) {
  if (merchant.portalConfigurationId) return merchant.portalConfigurationId;
  const config = await deps.stripe.createPortalConfiguration(merchant.stripeAccountId, {
    headline,
    returnUrl: `${deps.config.appUrl}/account`,
  });
  await deps.db.update(merchantAccounts).set({ portalConfigurationId: config.id }).where(eq(merchantAccounts.id, merchant.id));
  return config.id;
}
