import { membershipPlans, planPrices, type DbOrTx } from "@flock/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { ANALYTICS } from "../analytics-events";
import type { Deps } from "../deps";
import { isSupportedCurrency, parseMajorToMinor, priceBounds, formatMoney } from "../domain/money";
import { AppError, NotFoundError } from "../errors";
import { LIMITS } from "../pricing";
import { audit, track } from "./audit";
import { getOwnedCommunity } from "./communities";
import { getMerchantForCreator } from "./merchant";

const PlanFields = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(80),
  description: z.string().trim().max(500).default(""),
});

const PlanCreateInput = PlanFields.extend({
  price: z.string().trim().min(1, "Enter a price"),
  currency: z.string().trim().toLowerCase().default("usd"),
});

/** Parse and bound-check a creator-entered price. */
export function parsePlanPrice(price: string, currency: string): number {
  if (!isSupportedCurrency(currency)) throw new AppError("invalid_currency", "That currency isn't supported yet.");
  const amount = parseMajorToMinor(price, currency);
  const { min, max } = priceBounds(currency);
  if (amount === null) throw new AppError("invalid_price", "Enter a price like 19 or 19.99.");
  if (amount < min || amount > max) {
    throw new AppError("invalid_price", `Price must be between ${formatMoney(min, currency)} and ${formatMoney(max, currency)}.`);
  }
  return amount;
}

export async function listPlans(db: DbOrTx, communityId: string) {
  return db
    .select({ plan: membershipPlans, price: planPrices })
    .from(membershipPlans)
    .leftJoin(planPrices, eq(planPrices.id, membershipPlans.currentPriceId))
    .where(eq(membershipPlans.communityId, communityId))
    .orderBy(desc(membershipPlans.createdAt));
}

export async function listPriceVersions(db: DbOrTx, planId: string) {
  return db.select().from(planPrices).where(eq(planPrices.planId, planId)).orderBy(desc(planPrices.createdAt));
}

/** Create plan + Stripe Product + monthly Price on the creator's connected account. */
export async function createPlan(deps: Deps, creatorId: string, actorUserId: string, raw: unknown) {
  const input = PlanCreateInput.parse(raw);
  const amountMinor = parsePlanPrice(input.price, input.currency);
  const community = await getOwnedCommunity(deps.db, creatorId);
  if (!community) throw new NotFoundError("Create a community first.");
  const merchant = await getMerchantForCreator(deps.db, creatorId);
  if (!merchant || merchant.disconnectedAt) throw new AppError("no_merchant", "Connect Stripe before creating a plan.");

  const active = await deps.db
    .select({ id: membershipPlans.id })
    .from(membershipPlans)
    .where(and(eq(membershipPlans.communityId, community.id), eq(membershipPlans.status, "active")));
  if (active.length >= LIMITS.activePlansPerCommunity) {
    throw new AppError("plan_limit", "During early access each community has one active plan. Edit or deactivate the existing plan.");
  }

  // Insert locally first so the Stripe idempotency keys are stable per plan.
  const [plan] = await deps.db
    .insert(membershipPlans)
    .values({ communityId: community.id, merchantAccountId: merchant.id, name: input.name, description: input.description, status: "inactive" })
    .returning();
  if (!plan) throw new Error("insert failed");

  let product: { id: string };
  let price: { id: string };
  let priceRowId: string | null = null;
  try {
    product = await deps.stripe.createProduct(
      merchant.stripeAccountId,
      { name: `${community.name} — ${input.name}`, description: input.description || community.name, metadata: { flock_plan_id: plan.id, flock_community_id: community.id } },
      `flock-product:${plan.id}`,
    );
    const [inserted] = await deps.db.insert(planPrices).values({ planId: plan.id, amountMinor, currency: input.currency }).returning();
    if (!inserted) throw new Error("insert failed");
    priceRowId = inserted.id;
    price = await deps.stripe.createMonthlyPrice(
      merchant.stripeAccountId,
      { productId: product.id, amountMinor, currency: input.currency, metadata: { flock_plan_id: plan.id, flock_plan_price_id: inserted.id } },
      `flock-price:${inserted.id}`,
    );
  } catch (err) {
    // Don't leave a half-created plan behind; the creator can simply retry.
    if (priceRowId) await deps.db.delete(planPrices).where(eq(planPrices.id, priceRowId));
    await deps.db.delete(membershipPlans).where(eq(membershipPlans.id, plan.id));
    throw err;
  }
  const priceRow = { id: priceRowId as string };

  return deps.db.transaction(async (tx) => {
    await tx.update(planPrices).set({ stripePriceId: price.id }).where(eq(planPrices.id, priceRow.id));
    const [updated] = await tx
      .update(membershipPlans)
      .set({ stripeProductId: product.id, currentPriceId: priceRow.id, status: "active" })
      .where(eq(membershipPlans.id, plan.id))
      .returning();
    await audit(tx, { actorType: "user", actorUserId, creatorId, communityId: community.id, action: "plan.created", details: { planId: plan.id, amountMinor, currency: input.currency } });
    await track(tx, ANALYTICS.planCreated, { userId: actorUserId, creatorId, communityId: community.id }, { amountMinor, currency: input.currency });
    return updated!;
  });
}

async function getOwnedPlan(db: DbOrTx, creatorId: string, planId: string) {
  const community = await getOwnedCommunity(db, creatorId);
  if (!community) throw new NotFoundError();
  const [plan] = await db
    .select()
    .from(membershipPlans)
    .where(and(eq(membershipPlans.id, planId), eq(membershipPlans.communityId, community.id)))
    .limit(1);
  if (!plan) throw new NotFoundError();
  return { plan, community };
}

/** Edit name/description (Stripe Product updated in place; Prices are immutable). */
export async function updatePlanDetails(deps: Deps, creatorId: string, actorUserId: string, planId: string, raw: unknown) {
  const input = PlanFields.parse(raw);
  const { plan, community } = await getOwnedPlan(deps.db, creatorId, planId);
  const merchant = await getMerchantForCreator(deps.db, creatorId);
  if (plan.stripeProductId && merchant) {
    await deps.stripe.updateProduct(merchant.stripeAccountId, plan.stripeProductId, {
      name: `${community.name} — ${input.name}`,
      description: input.description || community.name,
    });
  }
  await deps.db.update(membershipPlans).set({ name: input.name, description: input.description }).where(eq(membershipPlans.id, plan.id));
  await audit(deps.db, { actorType: "user", actorUserId, creatorId, communityId: community.id, action: "plan.updated", details: { planId } });
}

/**
 * Change price: creates a new Stripe Price version for new checkouts.
 * Rule: existing subscribers keep the price they signed up at (grandfathered).
 */
export async function changePlanPrice(deps: Deps, creatorId: string, actorUserId: string, planId: string, raw: unknown) {
  const input = z.object({ price: z.string().trim(), currency: z.string().trim().toLowerCase().default("usd") }).parse(raw);
  const amountMinor = parsePlanPrice(input.price, input.currency);
  const { plan, community } = await getOwnedPlan(deps.db, creatorId, planId);
  const merchant = await getMerchantForCreator(deps.db, creatorId);
  if (!merchant || !plan.stripeProductId) throw new AppError("no_merchant", "Stripe isn't connected.");
  const [current] = plan.currentPriceId ? await deps.db.select().from(planPrices).where(eq(planPrices.id, plan.currentPriceId)) : [];
  if (current && current.amountMinor === amountMinor && current.currency === input.currency) return plan;

  const [priceRow] = await deps.db.insert(planPrices).values({ planId: plan.id, amountMinor, currency: input.currency }).returning();
  if (!priceRow) throw new Error("insert failed");
  const price = await deps.stripe.createMonthlyPrice(
    merchant.stripeAccountId,
    { productId: plan.stripeProductId, amountMinor, currency: input.currency, metadata: { flock_plan_id: plan.id, flock_plan_price_id: priceRow.id } },
    `flock-price:${priceRow.id}`,
  );
  if (current?.stripePriceId) await deps.stripe.setPriceActive(merchant.stripeAccountId, current.stripePriceId, false);
  await deps.db.transaction(async (tx) => {
    await tx.update(planPrices).set({ stripePriceId: price.id }).where(eq(planPrices.id, priceRow.id));
    if (current) await tx.update(planPrices).set({ active: false }).where(eq(planPrices.id, current.id));
    await tx.update(membershipPlans).set({ currentPriceId: priceRow.id }).where(eq(membershipPlans.id, plan.id));
    await audit(tx, {
      actorType: "user",
      actorUserId,
      creatorId,
      communityId: community.id,
      action: "plan.price_changed",
      details: { planId, from: current?.amountMinor ?? null, to: amountMinor, currency: input.currency },
    });
  });
  return plan;
}

export async function setPlanStatus(deps: Deps, creatorId: string, actorUserId: string, planId: string, status: "active" | "inactive") {
  const { plan, community } = await getOwnedPlan(deps.db, creatorId, planId);
  if (status === "active" && plan.status !== "active") {
    const active = await deps.db
      .select({ id: membershipPlans.id })
      .from(membershipPlans)
      .where(and(eq(membershipPlans.communityId, community.id), eq(membershipPlans.status, "active")));
    if (active.length >= LIMITS.activePlansPerCommunity) throw new AppError("plan_limit", "Deactivate the other plan first.");
  }
  await deps.db.update(membershipPlans).set({ status }).where(eq(membershipPlans.id, plan.id));
  await audit(deps.db, { actorType: "user", actorUserId, creatorId, communityId: community.id, action: `plan.${status === "active" ? "activated" : "deactivated"}`, details: { planId } });
}
