"use server";

import {
  changePlanPrice,
  createCommunity,
  createFreshOnboardingLink,
  createPlan,
  disconnectCommunityChat,
  getMerchantForCreator,
  getOwnedCommunity,
  platformPortalUrl,
  publishCommunity,
  recheckCommunityChat,
  refreshMerchant,
  setPlanStatus,
  startChatConnection,
  startMerchantOnboarding,
  startPlatformCheckout,
  unpublishCommunity,
  updateCommunity,
  updatePlanDetails,
  type ConnectChatType,
} from "@flock/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/components/ui/form-message";
import { deps } from "@/lib/server/deps";
import { userMessage } from "@/lib/server/http";
import { allow } from "@/lib/server/rate-limit";
import { creatorForAction } from "@/lib/server/session";

const SIGNED_OUT_MESSAGE = "Your session ended. Please sign in again.";
const SIGNED_OUT: FormState = { error: SIGNED_OUT_MESSAGE };
const SLOW_DOWN: FormState = { error: "Too many attempts. Please wait a minute and try again." };

const text = (fd: FormData, key: string) => {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
};

function communityFields(fd: FormData) {
  return {
    name: text(fd, "name"),
    slug: text(fd, "slug"),
    description: text(fd, "description"),
    benefits: text(fd, "benefits")
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean),
    supportContact: text(fd, "supportContact") || null,
    avatarUrl: text(fd, "avatarUrl") || null,
  };
}

export async function saveCommunityAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await creatorForAction();
  if (!ctx) return SIGNED_OUT;
  const d = deps();
  try {
    const existing = await getOwnedCommunity(d.db, ctx.creator.id);
    if (existing) await updateCommunity(d, ctx.creator.id, existing.id, ctx.user.id, communityFields(fd));
    else await createCommunity(d, ctx.creator.id, ctx.user.id, communityFields(fd));
  } catch (err) {
    return { error: userMessage(err, "community.save") };
  }
  revalidatePath("/dashboard", "layout");
  return { ok: true, message: "Saved." };
}

export async function startTelegramConnectionAction(chatType: ConnectChatType): Promise<{ error?: string; requestId?: string; deepLink?: string }> {
  const ctx = await creatorForAction();
  if (!ctx) return { error: SIGNED_OUT_MESSAGE };
  if (chatType !== "channel" && chatType !== "group") return { error: "Choose a channel or a group." };
  try {
    const { request, deepLink } = await startChatConnection(deps(), ctx.creator.id, ctx.user, chatType);
    return { requestId: request.id, deepLink };
  } catch (err) {
    return { error: userMessage(err, "telegram.start_connection") };
  }
}

export async function recheckChatAction(_prev: FormState): Promise<FormState> {
  const ctx = await creatorForAction();
  if (!ctx) return SIGNED_OUT;
  if (!(await allow(`chat:recheck:${ctx.creator.id}`, 10, 60_000))) return SLOW_DOWN;
  try {
    const r = await recheckCommunityChat(deps(), ctx.creator.id);
    revalidatePath("/dashboard", "layout");
    return r?.status === "connected" ? { ok: true, message: "The bot has everything it needs." } : { error: r?.reason ?? "The chat still needs attention." };
  } catch (err) {
    return { error: userMessage(err, "telegram.recheck") };
  }
}

export async function disconnectChatAction(_prev: FormState): Promise<FormState> {
  const ctx = await creatorForAction();
  if (!ctx) return SIGNED_OUT;
  try {
    await disconnectCommunityChat(deps(), ctx.creator.id, ctx.user.id);
  } catch (err) {
    return { error: userMessage(err, "telegram.disconnect") };
  }
  revalidatePath("/dashboard", "layout");
  return { ok: true, message: "Chat disconnected. Your page is unpublished until you connect a chat again." };
}

export async function startStripeOnboardingAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await creatorForAction();
  if (!ctx) return SIGNED_OUT;
  if (!(await allow(`stripe:onboard:${ctx.creator.id}`, 10, 10 * 60_000))) return SLOW_DOWN;
  let url: string;
  try {
    url = await startMerchantOnboarding(deps(), ctx.creator.id, ctx.user.id, { contactEmail: text(fd, "contactEmail") });
  } catch (err) {
    return { error: userMessage(err, "stripe.onboard") };
  }
  redirect(url);
}

export async function continueStripeOnboardingAction(_prev: FormState): Promise<FormState> {
  const ctx = await creatorForAction();
  if (!ctx) return SIGNED_OUT;
  if (!(await allow(`stripe:onboard:${ctx.creator.id}`, 10, 10 * 60_000))) return SLOW_DOWN;
  let url: string;
  try {
    url = await createFreshOnboardingLink(deps(), ctx.creator.id);
  } catch (err) {
    return { error: userMessage(err, "stripe.continue") };
  }
  redirect(url);
}

export async function refreshStripeAction(_prev: FormState): Promise<FormState> {
  const ctx = await creatorForAction();
  if (!ctx) return SIGNED_OUT;
  if (!(await allow(`stripe:refresh:${ctx.creator.id}`, 10, 60_000))) return SLOW_DOWN;
  const d = deps();
  try {
    const merchant = await getMerchantForCreator(d.db, ctx.creator.id);
    if (!merchant) return { error: "Stripe isn't connected yet." };
    await refreshMerchant(d, merchant.stripeAccountId);
  } catch (err) {
    return { error: userMessage(err, "stripe.refresh_status") };
  }
  revalidatePath("/dashboard", "layout");
  return { ok: true, message: "Status updated from Stripe." };
}

export async function createPlanAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await creatorForAction();
  if (!ctx) return SIGNED_OUT;
  if (!(await allow(`plan:write:${ctx.creator.id}`, 20, 10 * 60_000))) return SLOW_DOWN;
  try {
    await createPlan(deps(), ctx.creator.id, ctx.user.id, {
      name: text(fd, "name"),
      description: text(fd, "description"),
      price: text(fd, "price"),
      currency: text(fd, "currency") || "usd",
    });
  } catch (err) {
    return { error: userMessage(err, "plan.create") };
  }
  revalidatePath("/dashboard", "layout");
  return { ok: true, message: "Plan created." };
}

export async function updatePlanAction(planId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await creatorForAction();
  if (!ctx) return SIGNED_OUT;
  if (!(await allow(`plan:write:${ctx.creator.id}`, 20, 10 * 60_000))) return SLOW_DOWN;
  try {
    await updatePlanDetails(deps(), ctx.creator.id, ctx.user.id, planId, { name: text(fd, "name"), description: text(fd, "description") });
  } catch (err) {
    return { error: userMessage(err, "plan.update") };
  }
  revalidatePath("/dashboard", "layout");
  return { ok: true, message: "Plan details saved." };
}

export async function changePriceAction(planId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await creatorForAction();
  if (!ctx) return SIGNED_OUT;
  if (!(await allow(`plan:write:${ctx.creator.id}`, 20, 10 * 60_000))) return SLOW_DOWN;
  try {
    await changePlanPrice(deps(), ctx.creator.id, ctx.user.id, planId, { price: text(fd, "price"), currency: text(fd, "currency") || "usd" });
  } catch (err) {
    return { error: userMessage(err, "plan.price") };
  }
  revalidatePath("/dashboard", "layout");
  return { ok: true, message: "New price saved. It applies to new members; existing members keep their current price." };
}

export async function setPlanStatusAction(planId: string, status: "active" | "inactive", _prev: FormState): Promise<FormState> {
  const ctx = await creatorForAction();
  if (!ctx) return SIGNED_OUT;
  try {
    await setPlanStatus(deps(), ctx.creator.id, ctx.user.id, planId, status);
  } catch (err) {
    return { error: userMessage(err, "plan.status") };
  }
  revalidatePath("/dashboard", "layout");
  return { ok: true, message: status === "active" ? "Plan reactivated." : "Plan deactivated. Existing members keep their subscriptions." };
}

export async function publishAction(_prev: FormState): Promise<FormState> {
  const ctx = await creatorForAction();
  if (!ctx) return SIGNED_OUT;
  try {
    await publishCommunity(deps(), ctx.creator.id, ctx.user.id);
  } catch (err) {
    return { error: userMessage(err, "community.publish") };
  }
  revalidatePath("/dashboard", "layout");
  return { ok: true, message: "Your membership page is live." };
}

export async function unpublishAction(_prev: FormState): Promise<FormState> {
  const ctx = await creatorForAction();
  if (!ctx) return SIGNED_OUT;
  try {
    await unpublishCommunity(deps(), ctx.creator.id, ctx.user.id);
  } catch (err) {
    return { error: userMessage(err, "community.unpublish") };
  }
  revalidatePath("/dashboard", "layout");
  return { ok: true, message: "Page unpublished. Existing members keep their access." };
}

export async function platformCheckoutAction(planKey: string, _prev: FormState): Promise<FormState> {
  const ctx = await creatorForAction();
  if (!ctx) return SIGNED_OUT;
  let url: string;
  try {
    url = await startPlatformCheckout(deps(), ctx.creator.id, planKey);
  } catch (err) {
    return { error: userMessage(err, "platform.checkout") };
  }
  redirect(url);
}

export async function platformPortalAction(_prev: FormState): Promise<FormState> {
  const ctx = await creatorForAction();
  if (!ctx) return SIGNED_OUT;
  let url: string;
  try {
    url = await platformPortalUrl(deps(), ctx.creator.id);
  } catch (err) {
    return { error: userMessage(err, "platform.portal") };
  }
  redirect(url);
}
