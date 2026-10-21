import { creators, platformSubscriptions } from "@flock/db";
import { eq } from "drizzle-orm";
import type { Deps } from "../deps";
import { AppError, NotFoundError } from "../errors";
import { PLATFORM_PLANS, type PlatformPlanKey } from "../pricing";
import { audit } from "./audit";

/** Flock's own SaaS billing (D-010). Disabled unless PLATFORM_BILLING_ENABLED. */
export function platformBillingAvailable(deps: Pick<Deps, "config">) {
  return deps.config.platformBilling.enabled;
}

function priceIdFor(deps: Pick<Deps, "config">, plan: Exclude<PlatformPlanKey, "beta">) {
  const id = deps.config.platformBilling.priceIds[plan];
  if (!id) throw new AppError("billing_unconfigured", "Billing isn't configured.");
  return id;
}

function planForPrice(deps: Pick<Deps, "config">, priceId: string | null): Exclude<PlatformPlanKey, "beta"> | null {
  const { starter, growth } = deps.config.platformBilling.priceIds;
  if (priceId && priceId === starter) return "starter";
  if (priceId && priceId === growth) return "growth";
  return null;
}

export async function startPlatformCheckout(deps: Deps, creatorId: string, planKey: string) {
  if (!platformBillingAvailable(deps)) throw new AppError("billing_disabled", "Flock is free during early access.");
  if (planKey !== "starter" && planKey !== "growth") throw new AppError("invalid_plan", "Unknown plan.");
  const [creator] = await deps.db.select().from(creators).where(eq(creators.id, creatorId)).limit(1);
  if (!creator) throw new NotFoundError();
  let customerId = creator.platformStripeCustomerId;
  if (!customerId) {
    const c = await deps.stripe.createPlatformCustomer(
      { name: creator.displayName, email: creator.contactEmail, metadata: { flock_creator_id: creator.id } },
      `flock-platform-customer:${creator.id}`,
    );
    customerId = c.id;
    await deps.db.update(creators).set({ platformStripeCustomerId: customerId }).where(eq(creators.id, creator.id));
  }
  const session = await deps.stripe.createPlatformCheckout(
    {
      customerId,
      priceId: priceIdFor(deps, planKey),
      clientReferenceId: creator.id,
      metadata: { flock_creator_id: creator.id, flock_platform_plan: planKey },
      successUrl: `${deps.config.appUrl}/dashboard/billing?checkout=success`,
      cancelUrl: `${deps.config.appUrl}/dashboard/billing?checkout=canceled`,
    },
    `flock-platform-checkout:${creator.id}:${planKey}:${Math.floor(deps.now().getTime() / 600_000)}`,
  );
  if (!session.url) throw new Error("Stripe returned no checkout URL");
  return session.url;
}

export async function platformPortalUrl(deps: Deps, creatorId: string) {
  const [creator] = await deps.db.select().from(creators).where(eq(creators.id, creatorId)).limit(1);
  if (!creator?.platformStripeCustomerId) throw new AppError("no_billing", "You don't have a Flock subscription yet.");
  const s = await deps.stripe.createPlatformPortalSession({ customerId: creator.platformStripeCustomerId, returnUrl: `${deps.config.appUrl}/dashboard/billing` });
  return s.url;
}

/** Converge a platform subscription from Stripe. Returns false if not ours. */
export async function syncPlatformSubscription(deps: Deps, stripeSubscriptionId: string | null): Promise<boolean> {
  if (!stripeSubscriptionId) return false;
  const remote = await deps.stripe.retrievePlatformSubscription(stripeSubscriptionId);
  const planKey = planForPrice(deps, remote.priceId);
  const [creator] = await deps.db.select().from(creators).where(eq(creators.platformStripeCustomerId, remote.customerId)).limit(1);
  if (!creator || !planKey) return false;
  if (remote.metadata.flock_creator_id && remote.metadata.flock_creator_id !== creator.id) return false;

  await deps.db.transaction(async (tx) => {
    await tx
      .insert(platformSubscriptions)
      .values({
        creatorId: creator.id,
        stripeSubscriptionId: remote.id,
        stripeCustomerId: remote.customerId,
        planKey,
        status: remote.status,
        cancelAtPeriodEnd: remote.cancelAtPeriodEnd,
        currentPeriodEnd: remote.currentPeriodEnd,
        lastSyncedAt: deps.now(),
      })
      .onConflictDoUpdate({
        target: platformSubscriptions.stripeSubscriptionId,
        set: { planKey, status: remote.status, cancelAtPeriodEnd: remote.cancelAtPeriodEnd, currentPeriodEnd: remote.currentPeriodEnd, lastSyncedAt: deps.now() },
      });
    const entitled = remote.status === "active" || remote.status === "trialing" || remote.status === "past_due";
    const newPlan = entitled ? planKey : "beta";
    if (newPlan !== creator.platformPlan) {
      await tx.update(creators).set({ platformPlan: newPlan }).where(eq(creators.id, creator.id));
      await audit(tx, { actorType: "stripe", creatorId: creator.id, action: "platform.plan_changed", details: { from: creator.platformPlan, to: newPlan, status: remote.status } });
    }
  });
  return true;
}

export function platformPlanInfo(key: PlatformPlanKey) {
  return PLATFORM_PLANS.find((p) => p.key === key) ?? PLATFORM_PLANS[0];
}
