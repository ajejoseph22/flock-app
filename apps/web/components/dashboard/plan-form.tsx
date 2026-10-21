"use client";

import { SUPPORTED_CURRENCIES } from "@flock/core/domain/money";
import { useActionState } from "react";
import { createPlanAction } from "@/app/dashboard/actions";
import { FormMessage } from "@/components/ui/form-message";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";

export function CurrencySelect({ defaultValue = "usd", id = "currency" }: { defaultValue?: string; id?: string }) {
  return (
    <Select id={id} name="currency" defaultValue={defaultValue}>
      {SUPPORTED_CURRENCIES.map((c) => (
        <option key={c} value={c}>
          {c.toUpperCase()}
        </option>
      ))}
    </Select>
  );
}

export function CreatePlanForm({ defaultCurrency }: { defaultCurrency: string }) {
  const [state, formAction] = useActionState(createPlanAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-5">
      <Field label="Plan name" htmlFor="plan-name">
        <Input id="plan-name" name="name" required minLength={2} maxLength={80} defaultValue="Monthly membership" />
      </Field>
      <Field label="Description (optional)" htmlFor="plan-description">
        <Textarea id="plan-description" name="description" maxLength={500} rows={2} />
      </Field>
      <div className="grid grid-cols-[1fr_7rem] gap-3">
        <Field label="Monthly price" htmlFor="plan-price" hint="Billed every month until the member cancels.">
          <Input id="plan-price" name="price" inputMode="decimal" required placeholder="19.00" />
        </Field>
        <Field label="Currency" htmlFor="plan-currency">
          <CurrencySelect id="plan-currency" defaultValue={defaultCurrency} />
        </Field>
      </div>
      <FormMessage state={state} />
      <div>
        <SubmitButton pendingText="Creating on Stripe…">Create plan</SubmitButton>
      </div>
    </form>
  );
}
