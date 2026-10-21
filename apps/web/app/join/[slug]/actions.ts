"use server";

import { createCheckout } from "@flock/core";
import { redirect } from "next/navigation";
import type { FormState } from "@/components/ui/form-message";
import { deps } from "@/lib/server/deps";
import { userMessage } from "@/lib/server/http";
import { allow } from "@/lib/server/rate-limit";
import { currentUser, loginUrl } from "@/lib/server/session";

/** Start Stripe Checkout. Only the slug comes from the client; price, account and amount come from the database. */
export async function joinAction(slug: string, _prev: FormState): Promise<FormState> {
  const user = await currentUser();
  if (!user) redirect(loginUrl(`/join/${slug}`));
  if (!(await allow(`checkout:${user.id}`, 10, 10 * 60_000))) return { error: "Too many attempts. Please wait a few minutes and try again." };
  let url: string;
  try {
    ({ url } = await createCheckout(deps(), user, slug));
  } catch (err) {
    return { error: userMessage(err, "checkout.create") };
  }
  redirect(url);
}
