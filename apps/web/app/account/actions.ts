"use server";

import { createSubscriberPortalSession } from "@flock/core";
import { redirect } from "next/navigation";
import type { FormState } from "@/components/ui/form-message";
import { deps } from "@/lib/server/deps";
import { userMessage } from "@/lib/server/http";
import { allow } from "@/lib/server/rate-limit";
import { currentUser } from "@/lib/server/session";

/** Stripe Billing Portal for one of the signed-in user's own subscriptions. */
export async function manageBillingAction(subscriptionId: string, _prev: FormState): Promise<FormState> {
  const user = await currentUser();
  if (!user) return { error: "Your session ended. Please sign in again." };
  if (!(await allow(`portal:${user.id}`, 20, 10 * 60_000))) return { error: "Too many attempts. Please wait a few minutes." };
  let url: string;
  try {
    url = await createSubscriberPortalSession(deps(), user.id, subscriptionId);
  } catch (err) {
    return { error: userMessage(err, "portal.create") };
  }
  redirect(url);
}
