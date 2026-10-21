"use client";

import { Lock } from "lucide-react";
import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { joinAction } from "./actions";

export function JoinButton({ slug, label }: { slug: string; label: string }) {
  const [state, formAction] = useActionState(joinAction.bind(null, slug), null);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <SubmitButton size="lg" className="w-full" pendingText="Opening secure checkout…">
        <Lock aria-hidden /> {label}
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}
