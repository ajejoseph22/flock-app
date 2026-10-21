import { merchantDisplayState } from "@flock/core/services/merchant";
import type { merchantAccounts } from "@flock/db";
import { Badge, type BadgeTone } from "@/components/ui/badge";

type Merchant = typeof merchantAccounts.$inferSelect;

const LABELS: Record<ReturnType<typeof merchantDisplayState>, { label: string; tone: BadgeTone; body: string }> = {
  not_connected: { label: "Not connected", tone: "neutral", body: "Connect a Stripe account to accept payments." },
  onboarding: { label: "Needs information", tone: "warning", body: "Stripe needs a few more details before you can accept payments." },
  pending_review: { label: "Under review", tone: "warning", body: "Stripe is reviewing your details. This usually takes minutes, sometimes longer." },
  ready: { label: "Ready", tone: "success", body: "Stripe has enabled card payments on your account." },
  restricted: { label: "Restricted", tone: "danger", body: "Stripe has paused payments on your account. Open Stripe to see what's needed." },
  rejected: { label: "Not supported", tone: "danger", body: "Stripe can't enable payments for this account. Check your Stripe dashboard or contact Stripe support." },
};

export function merchantStatus(merchant: Merchant | null) {
  const state = merchantDisplayState(merchant);
  return { state, ...LABELS[state] };
}

export function MerchantStatusBadge({ merchant }: { merchant: Merchant | null }) {
  const s = merchantStatus(merchant);
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function MerchantRequirements({ merchant }: { merchant: Merchant }) {
  const due = merchant.requirements.filter((r) => r.awaitingActionFrom === "user");
  if (due.length === 0) return null;
  return (
    <div className="rounded-md bg-muted p-3 text-sm">
      <p className="font-medium">Stripe is asking for:</p>
      <ul className="mt-1 list-disc pl-5 text-muted-foreground">
        {due.slice(0, 8).map((r) => (
          <li key={r.description}>{r.description}</li>
        ))}
      </ul>
    </div>
  );
}
