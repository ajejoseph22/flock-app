import type { BadgeTone } from "@/components/ui/badge";

/** Human labels for entitlement reasons (domain/eligibility.ts). */
export function accessLabel(entitlementStatus: string | null, reason: string | null): { label: string; tone: BadgeTone } {
  if (entitlementStatus === "active") {
    if (reason === "grace_period") return { label: "Grace period", tone: "warning" };
    if (reason === "canceled_until_period_end") return { label: "Ending", tone: "neutral" };
    return { label: "Active", tone: "success" };
  }
  switch (reason) {
    case "refunded":
      return { label: "Refunded", tone: "danger" };
    case "disputed":
      return { label: "Disputed", tone: "danger" };
    case "payment_failed":
      return { label: "Payment failed", tone: "danger" };
    case "never_paid":
      return { label: "Not paid", tone: "neutral" };
    case "expired":
      return { label: "Ended", tone: "neutral" };
    default:
      return entitlementStatus === "ended" ? { label: "Ended", tone: "neutral" } : { label: "Pending payment", tone: "neutral" };
  }
}

export function telegramLabel(state: string | null): { label: string; tone: BadgeTone } {
  switch (state) {
    case "member":
      return { label: "In chat", tone: "success" };
    case "invited":
      return { label: "Invite sent", tone: "primary" };
    case "pending":
      return { label: "Preparing invite", tone: "neutral" };
    case "revoking":
      return { label: "Removing", tone: "warning" };
    case "revoked":
      return { label: "Removed", tone: "neutral" };
    case "left":
      return { label: "Left chat", tone: "neutral" };
    case "failed":
      return { label: "Problem", tone: "danger" };
    default:
      return { label: "—", tone: "neutral" };
  }
}

const ACTIONS: Record<string, string> = {
  "entitlement.activated": "Access granted",
  "entitlement.ended": "Access ended",
  "entitlement.updated": "Membership updated",
  "access.invite_issued": "Invite link sent",
  "access.join_approved": "Join request approved",
  "access.join_declined": "Join request declined",
  "access.already_member": "Already in the chat",
  "access.grant_failed": "Couldn't grant access",
  "access.revoked": "Removed from chat",
  "access.removed_by_admin": "Removed by a chat admin",
  "access.left_chat": "Left the chat",
};

export function auditLabel(action: string): string {
  if (ACTIONS[action]) return ACTIONS[action];
  if (action.startsWith("access.revoke_")) return `Removal skipped (${action.slice("access.revoke_".length).replace(/_/g, " ")})`;
  return action.replace(/[._]/g, " ");
}
