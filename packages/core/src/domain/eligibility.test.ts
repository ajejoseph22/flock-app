import { describe, expect, it } from "vitest";
import { computePaidThrough, evaluateEntitlement } from "./eligibility";

const HOUR = 3_600_000;
const GRACE = 48 * HOUR;
const now = new Date("2026-06-15T12:00:00Z");
const later = (h: number) => new Date(now.getTime() + h * HOUR);
const earlier = (h: number) => new Date(now.getTime() - h * HOUR);

const base = { disputed: false, now, graceMs: GRACE };

describe("evaluateEntitlement", () => {
  it("active subscription with future paid-through is eligible until paid-through + grace", () => {
    const r = evaluateEntitlement({ ...base, status: "active", paidThrough: later(24 * 10) });
    expect(r).toEqual({ eligible: true, reason: "active", accessEndsAt: new Date(later(24 * 10).getTime() + GRACE) });
  });

  it("renewal in progress: active past paid-through but within grace stays eligible", () => {
    const r = evaluateEntitlement({ ...base, status: "active", paidThrough: earlier(1) });
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe("grace_period");
  });

  it("failed renewal (past_due) keeps access during the 48h grace", () => {
    expect(evaluateEntitlement({ ...base, status: "past_due", paidThrough: earlier(47) }).eligible).toBe(true);
  });

  it("failed renewal (past_due) loses access after grace", () => {
    const r = evaluateEntitlement({ ...base, status: "past_due", paidThrough: earlier(49) });
    expect(r).toMatchObject({ eligible: false, reason: "payment_failed" });
  });

  it("grace is configurable", () => {
    expect(evaluateEntitlement({ ...base, graceMs: 0, status: "past_due", paidThrough: earlier(1) }).eligible).toBe(false);
    expect(evaluateEntitlement({ ...base, graceMs: 72 * HOUR, status: "past_due", paidThrough: earlier(71) }).eligible).toBe(true);
  });

  it("unpaid initial subscription is never eligible, grace or not", () => {
    for (const status of ["incomplete", "incomplete_expired", "active", "past_due"]) {
      const r = evaluateEntitlement({ ...base, status, paidThrough: null });
      expect(r).toEqual({ eligible: false, reason: "never_paid", accessEndsAt: null });
    }
  });

  it("incomplete never becomes eligible even with a stray paid invoice", () => {
    expect(evaluateEntitlement({ ...base, status: "incomplete", paidThrough: later(100) }).eligible).toBe(false);
  });

  it("cancel at period end keeps access until paid-through (+grace while still active)", () => {
    const r = evaluateEntitlement({ ...base, status: "active", cancelAtPeriodEnd: true, paidThrough: later(5) });
    expect(r).toMatchObject({ eligible: true, reason: "canceled_until_period_end" });
  });

  it("canceled subscription keeps access until paid-through with no grace", () => {
    const paidThrough = later(5);
    const r = evaluateEntitlement({ ...base, status: "canceled", paidThrough });
    expect(r).toEqual({ eligible: true, reason: "canceled_until_period_end", accessEndsAt: paidThrough });
    expect(evaluateEntitlement({ ...base, status: "canceled", paidThrough: earlier(1) })).toMatchObject({
      eligible: false,
      reason: "expired",
    });
  });

  it("boundary: access ends exactly at accessEndsAt", () => {
    const paidThrough = now;
    expect(evaluateEntitlement({ ...base, status: "canceled", paidThrough }).eligible).toBe(false);
    expect(evaluateEntitlement({ ...base, status: "canceled", paidThrough: new Date(now.getTime() + 1) }).eligible).toBe(true);
  });

  it("unpaid/paused get no grace", () => {
    expect(evaluateEntitlement({ ...base, status: "unpaid", paidThrough: earlier(1) })).toMatchObject({
      eligible: false,
      reason: "payment_failed",
    });
    expect(evaluateEntitlement({ ...base, status: "paused", paidThrough: earlier(1) }).eligible).toBe(false);
  });

  it("an open dispute suspends access immediately regardless of status", () => {
    expect(evaluateEntitlement({ ...base, disputed: true, status: "active", paidThrough: later(500) })).toMatchObject({
      eligible: false,
      reason: "disputed",
    });
  });

  it("refund of the latest invoice cuts access with no grace", () => {
    // Renewed yesterday (previous period ended 24h ago), renewal invoice refunded: paid-through falls back.
    const r = evaluateEntitlement({ ...base, status: "active", latestInvoiceRefunded: true, paidThrough: earlier(24) });
    expect(r).toMatchObject({ eligible: false, reason: "refunded" });
  });

  it("refund of the only invoice means never eligible", () => {
    expect(evaluateEntitlement({ ...base, status: "active", latestInvoiceRefunded: true, paidThrough: null })).toMatchObject({
      eligible: false,
      reason: "refunded",
    });
  });
});

describe("computePaidThrough", () => {
  const inv = (id: string, status: string, end: Date | null) => ({ id, status, periodEnd: end });

  it("takes the latest period end among paid invoices", () => {
    expect(computePaidThrough([inv("a", "paid", earlier(700)), inv("b", "paid", later(20))], [])).toEqual(later(20));
  });

  it("ignores unpaid and excluded invoices", () => {
    const r = computePaidThrough([inv("a", "paid", earlier(10)), inv("b", "open", later(700)), inv("c", "paid", later(20))], ["c"]);
    expect(r).toEqual(earlier(10));
  });

  it("returns null when nothing is paid", () => {
    expect(computePaidThrough([inv("a", "open", later(1)), inv("b", "void", later(2))], [])).toBeNull();
  });
});
