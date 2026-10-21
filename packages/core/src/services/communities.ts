import { communities, creators, merchantAccounts, membershipPlans, planPrices, telegramChats, type DbOrTx } from "@flock/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ANALYTICS } from "../analytics-events";
import type { Deps } from "../deps";
import { validateSlug } from "../domain/slug";
import { AppError, NotFoundError } from "../errors";
import { LIMITS } from "../pricing";
import { audit, track } from "./audit";
import { isMerchantReady } from "./merchant";

export async function getCreatorByUserId(db: DbOrTx, userId: string) {
  const [creator] = await db.select().from(creators).where(eq(creators.userId, userId)).limit(1);
  return creator ?? null;
}

/** Become a creator (idempotent). */
export async function ensureCreator(db: DbOrTx, user: { id: string; firstName: string; lastName: string | null }) {
  const existing = await getCreatorByUserId(db, user.id);
  if (existing) return existing;
  const [created] = await db
    .insert(creators)
    .values({ userId: user.id, displayName: [user.firstName, user.lastName].filter(Boolean).join(" ") || "Creator" })
    .onConflictDoNothing({ target: creators.userId })
    .returning();
  if (created) {
    await track(db, ANALYTICS.creatorRegistered, { userId: user.id, creatorId: created.id });
    return created;
  }
  const again = await getCreatorByUserId(db, user.id);
  if (!again) throw new Error("creator upsert race");
  return again;
}

export const CommunityInput = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(80),
  slug: z.string().trim().toLowerCase(),
  description: z.string().trim().max(2_000).default(""),
  benefits: z.array(z.string().trim().min(1).max(140)).max(LIMITS.benefitsPerCommunity).default([]),
  supportContact: z.string().trim().max(200).optional().nullable(),
  avatarUrl: z.url({ protocol: /^https$/ }).max(500).optional().nullable(),
  coverUrl: z.url({ protocol: /^https$/ }).max(500).optional().nullable(),
});
export type CommunityInput = z.infer<typeof CommunityInput>;

export async function createCommunity(deps: Pick<Deps, "db">, creatorId: string, actorUserId: string, raw: unknown) {
  const input = CommunityInput.parse(raw);
  const slugError = validateSlug(input.slug);
  if (slugError) throw new AppError("invalid_slug", slugError);
  return deps.db.transaction(async (tx) => {
    const existing = await tx.select({ id: communities.id }).from(communities).where(eq(communities.creatorId, creatorId));
    if (existing.length >= LIMITS.communitiesPerCreator) {
      throw new AppError("community_limit", "During early access each creator can run one community.");
    }
    const [taken] = await tx.select({ id: communities.id }).from(communities).where(eq(communities.slug, input.slug)).limit(1);
    if (taken) throw new AppError("slug_taken", "That address is already taken.");
    const [community] = await tx
      .insert(communities)
      .values({
        creatorId,
        name: input.name,
        slug: input.slug,
        description: input.description,
        benefits: input.benefits,
        supportContact: input.supportContact ?? null,
        avatarUrl: input.avatarUrl ?? null,
        coverUrl: input.coverUrl ?? null,
      })
      .returning();
    if (!community) throw new Error("insert failed");
    await audit(tx, { actorType: "user", actorUserId, creatorId, communityId: community.id, action: "community.created" });
    await track(tx, ANALYTICS.communityCreated, { userId: actorUserId, creatorId, communityId: community.id });
    return community;
  });
}

export async function updateCommunity(deps: Pick<Deps, "db">, creatorId: string, communityId: string, actorUserId: string, raw: unknown) {
  const input = CommunityInput.omit({ slug: true }).parse(raw);
  const [updated] = await deps.db
    .update(communities)
    .set({
      name: input.name,
      description: input.description,
      benefits: input.benefits,
      supportContact: input.supportContact ?? null,
      avatarUrl: input.avatarUrl ?? null,
      coverUrl: input.coverUrl ?? null,
    })
    .where(and(eq(communities.id, communityId), eq(communities.creatorId, creatorId)))
    .returning();
  if (!updated) throw new NotFoundError();
  await audit(deps.db, { actorType: "user", actorUserId, creatorId, communityId, action: "community.updated" });
  return updated;
}

/** Load a community only if it belongs to the creator. The single tenant gate for creator pages. */
export async function getOwnedCommunity(db: DbOrTx, creatorId: string, communityId?: string) {
  const where = communityId
    ? and(eq(communities.creatorId, creatorId), eq(communities.id, communityId))
    : eq(communities.creatorId, creatorId);
  const [community] = await db.select().from(communities).where(where).orderBy(communities.createdAt).limit(1);
  return community ?? null;
}

export type SetupStepKey = "identity" | "community" | "telegram" | "stripe" | "plan" | "publish";
export interface SetupStep {
  key: SetupStepKey;
  title: string;
  done: boolean;
  blockedReason?: string;
}

/** Everything the onboarding stepper and publish gate need, computed server-side. */
export async function getSetupState(db: DbOrTx, creatorId: string) {
  const community = await getOwnedCommunity(db, creatorId);
  const [merchant] = await db.select().from(merchantAccounts).where(eq(merchantAccounts.creatorId, creatorId)).limit(1);
  const chat = community
    ? (await db.select().from(telegramChats).where(eq(telegramChats.communityId, community.id)).limit(1))[0]
    : undefined;
  const plan = community
    ? (
        await db
          .select({ plan: membershipPlans, price: planPrices })
          .from(membershipPlans)
          .leftJoin(planPrices, eq(planPrices.id, membershipPlans.currentPriceId))
          .where(and(eq(membershipPlans.communityId, community.id), eq(membershipPlans.status, "active")))
          .limit(1)
      )[0]
    : undefined;

  const merchantReady = merchant ? isMerchantReady(merchant) : false;
  const chatOk = chat?.status === "connected";
  const planOk = Boolean(plan?.price?.stripePriceId);
  const steps: SetupStep[] = [
    { key: "identity", title: "Connect Telegram identity", done: true },
    { key: "community", title: "Create community", done: Boolean(community) },
    {
      key: "telegram",
      title: "Connect Telegram channel or group",
      done: chatOk,
      blockedReason: !community ? "Create your community first." : chat && !chatOk ? (chat.statusReason ?? "Needs attention") : undefined,
    },
    {
      key: "stripe",
      title: "Connect Stripe",
      done: merchantReady,
      blockedReason: merchant && !merchantReady ? "Stripe needs more information before you can accept payments." : undefined,
    },
    {
      key: "plan",
      title: "Create membership plan",
      done: planOk,
      blockedReason: !merchant ? "Connect Stripe first." : undefined,
    },
    {
      key: "publish",
      title: "Publish membership page",
      done: community?.status === "published",
    },
  ];
  const publishBlockers = steps.filter((s) => s.key !== "publish" && !s.done).map((s) => s.title);
  return { community: community ?? null, merchant: merchant ?? null, chat: chat ?? null, plan: plan ?? null, steps, publishBlockers, merchantReady };
}

export async function publishCommunity(deps: Pick<Deps, "db" | "now">, creatorId: string, actorUserId: string) {
  const state = await getSetupState(deps.db, creatorId);
  if (!state.community) throw new NotFoundError();
  if (state.publishBlockers.length > 0) {
    throw new AppError("not_ready", `Finish these steps first: ${state.publishBlockers.join(", ")}.`);
  }
  await deps.db
    .update(communities)
    .set({ status: "published", publishedAt: state.community.publishedAt ?? deps.now() })
    .where(and(eq(communities.id, state.community.id), eq(communities.creatorId, creatorId)));
  await audit(deps.db, { actorType: "user", actorUserId, creatorId, communityId: state.community.id, action: "community.published" });
  await track(deps.db, ANALYTICS.pagePublished, { userId: actorUserId, creatorId, communityId: state.community.id });
  return state.community.slug;
}

export async function unpublishCommunity(deps: Pick<Deps, "db">, creatorId: string, actorUserId: string) {
  const community = await getOwnedCommunity(deps.db, creatorId);
  if (!community) throw new NotFoundError();
  await deps.db.update(communities).set({ status: "draft" }).where(eq(communities.id, community.id));
  await audit(deps.db, { actorType: "user", actorUserId, creatorId, communityId: community.id, action: "community.unpublished" });
}
