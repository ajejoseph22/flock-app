/**
 * Entitlement eligibility (decision D-006). Pure: same inputs, same answer.
 * See docs/payment-and-access-lifecycle.md §2.
 */

export type EntitlementReason =
  | "active"
  | "grace_period"
  | "canceled_until_period_end"
  | "payment_failed"
  | "never_paid"
  | "expired"
  | "disputed"
  | "refunded";

export interface EligibilityInput {
  /** Stripe subscription status. */
  status: string;
  /** End of the latest period covered by a paid, non-excluded invoice. */
  paidThrough: Date | null;
  /** True if any payment on the subscription has an open dispute. */
  disputed: boolean;
  /** True if the most recent paid invoice was fully refunded (excluded). Refunds never get grace. */
  latestInvoiceRefunded?: boolean;
  cancelAtPeriodEnd?: boolean;
  now: Date;
  graceMs: number;
}

export interface EligibilityResult {
  eligible: boolean;
  reason: EntitlementReason;
  /** When access ends (or ended). Null if never eligible. */
  accessEndsAt: Date | null;
}

/** Statuses where Stripe is still trying to collect the renewal, so grace applies. */
const COLLECTING = new Set(["active", "trialing", "past_due"]);
/** Statuses that never had a successful first payment. */
const NEVER_PAID = new Set(["incomplete", "incomplete_expired"]);

export function evaluateEntitlement(input: EligibilityInput): EligibilityResult {
  const { status, paidThrough, disputed, now, graceMs } = input;
  const refunded = input.latestInvoiceRefunded === true;

  if (disputed) return { eligible: false, reason: "disputed", accessEndsAt: now };
  if (!paidThrough) return { eligible: false, reason: refunded ? "refunded" : "never_paid", accessEndsAt: null };
  if (NEVER_PAID.has(status)) return { eligible: false, reason: "never_paid", accessEndsAt: null };

  const graceApplies = COLLECTING.has(status) && !refunded;
  const accessEndsAt = new Date(paidThrough.getTime() + (graceApplies ? graceMs : 0));
  const t = now.getTime();

  if (t < paidThrough.getTime()) {
    const ending = status === "canceled" || input.cancelAtPeriodEnd === true;
    return { eligible: true, reason: ending ? "canceled_until_period_end" : "active", accessEndsAt };
  }
  if (t < accessEndsAt.getTime()) return { eligible: true, reason: "grace_period", accessEndsAt };
  if (refunded) return { eligible: false, reason: "refunded", accessEndsAt };
  if (status === "past_due" || status === "unpaid") return { eligible: false, reason: "payment_failed", accessEndsAt };
  return { eligible: false, reason: "expired", accessEndsAt };
}

/**
 * Paid-through date from paid invoices: the latest period end among invoices
 * that are paid and not excluded (refunded/disputed).
 */
export function computePaidThrough(
  invoices: { id: string; status: string; periodEnd: Date | null }[],
  excludedInvoiceIds: readonly string[],
): Date | null {
  let best: Date | null = null;
  for (const inv of invoices) {
    if (inv.status !== "paid" || !inv.periodEnd || excludedInvoiceIds.includes(inv.id)) continue;
    if (!best || inv.periodEnd.getTime() > best.getTime()) best = inv.periodEnd;
  }
  return best;
}
