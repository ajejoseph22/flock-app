"use client";

import { useActionState } from "react";
import type { ButtonSize, ButtonVariant } from "./button";
import { FormMessage, type FormState } from "./form-message";
import { SubmitButton } from "./submit-button";

/** A one-button form bound to a server action, with inline result. */
export function ActionButton({
  action,
  children,
  pendingText,
  variant,
  size,
  confirm,
  className,
}: {
  action: (prev: FormState) => Promise<FormState>;
  children: React.ReactNode;
  pendingText?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  confirm?: string;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form
      action={formAction}
      className={className ?? "flex flex-col items-start gap-3"}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      <SubmitButton variant={variant} size={size} pendingText={pendingText}>
        {children}
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}
