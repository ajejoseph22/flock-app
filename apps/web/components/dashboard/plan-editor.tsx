"use client";

import { useActionState } from "react";
import { changePriceAction, setPlanStatusAction, updatePlanAction } from "@/app/dashboard/actions";
import { ActionButton } from "@/components/ui/action-button";
import { FormMessage } from "@/components/ui/form-message";
import { Field, Input, Textarea } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { CurrencySelect } from "./plan-form";

export function PlanDetailsForm({ planId, name, description }: { planId: string; name: string; description: string }) {
  const [state, formAction] = useActionState(updatePlanAction.bind(null, planId), null);
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Plan name" htmlFor={`name-${planId}`}>
        <Input id={`name-${planId}`} name="name" required minLength={2} maxLength={80} defaultValue={name} />
      </Field>
      <Field label="Description" htmlFor={`desc-${planId}`}>
        <Textarea id={`desc-${planId}`} name="description" maxLength={500} rows={2} defaultValue={description} />
      </Field>
      <FormMessage state={state} />
      <div>
        <SubmitButton variant="outline" pendingText="Saving…">
          Save details
        </SubmitButton>
      </div>
    </form>
  );
}

export function PlanPriceForm({ planId, price, currency }: { planId: string; price: string; currency: string }) {
  const [state, formAction] = useActionState(changePriceAction.bind(null, planId), null);
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-[1fr_7rem] gap-3">
        <Field label="New monthly price" htmlFor={`price-${planId}`} hint="Applies to new members only. Existing members keep their price.">
          <Input id={`price-${planId}`} name="price" inputMode="decimal" required defaultValue={price} />
        </Field>
        <Field label="Currency" htmlFor={`currency-${planId}`}>
          <CurrencySelect id={`currency-${planId}`} defaultValue={currency} />
        </Field>
      </div>
      <FormMessage state={state} />
      <div>
        <SubmitButton variant="outline" pendingText="Updating Stripe…">
          Change price
        </SubmitButton>
      </div>
    </form>
  );
}

export function PlanStatusButton({ planId, active }: { planId: string; active: boolean }) {
  return active ? (
    <ActionButton
      action={setPlanStatusAction.bind(null, planId, "inactive")}
      variant="ghost"
      size="sm"
      confirm="Deactivate this plan? New members won't be able to join until you activate a plan. Existing members keep their subscriptions."
    >
      Deactivate plan
    </ActionButton>
  ) : (
    <ActionButton action={setPlanStatusAction.bind(null, planId, "active")} variant="outline" size="sm">
      Reactivate plan
    </ActionButton>
  );
}
