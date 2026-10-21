"use client";

import { ExternalLink } from "lucide-react";
import { useActionState } from "react";
import { continueStripeOnboardingAction, refreshStripeAction, startStripeOnboardingAction } from "@/app/dashboard/actions";
import { ActionButton } from "@/components/ui/action-button";
import { FormMessage } from "@/components/ui/form-message";
import { Field, Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";

export function StripeStartForm({ defaultEmail }: { defaultEmail: string | null }) {
  const [state, formAction] = useActionState(startStripeOnboardingAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        You&apos;ll finish setup on Stripe&apos;s own pages. Flock never sees or asks for your Stripe keys, bank details or ID documents.
      </p>
      <Field label="Contact email" htmlFor="contactEmail" hint="Stripe uses this for your account. Members won't see it.">
        <Input id="contactEmail" name="contactEmail" type="email" autoComplete="email" required defaultValue={defaultEmail ?? ""} />
      </Field>
      <FormMessage state={state} />
      <div>
        <SubmitButton pendingText="Opening Stripe…">
          Continue to Stripe <ExternalLink aria-hidden />
        </SubmitButton>
      </div>
    </form>
  );
}

export function StripeContinueButtons({ showContinue }: { showContinue: boolean }) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      {showContinue && (
        <ActionButton action={continueStripeOnboardingAction} pendingText="Opening Stripe…">
          Continue Stripe setup <ExternalLink aria-hidden />
        </ActionButton>
      )}
      <ActionButton action={refreshStripeAction} variant="outline" pendingText="Checking…">
        Check status again
      </ActionButton>
    </div>
  );
}
