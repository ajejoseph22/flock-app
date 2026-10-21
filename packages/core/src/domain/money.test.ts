import { describe, expect, it } from "vitest";
import { formatMoney, monthlyEquivalentMinor, parseMajorToMinor, sumByCurrency } from "./money";

describe("money", () => {
  it("parses decimal input into integer minor units without float error", () => {
    expect(parseMajorToMinor("19", "usd")).toBe(1900);
    expect(parseMajorToMinor("19.9", "usd")).toBe(1990);
    expect(parseMajorToMinor("19.99", "usd")).toBe(1999);
    expect(parseMajorToMinor("0.29", "usd")).toBe(29); // 0.29 * 100 = 28.999… in float
    expect(parseMajorToMinor("1,000.10", "usd")).toBe(100010);
  });

  it("rejects malformed amounts", () => {
    for (const bad of ["", "abc", "-5", "1.999", "1e3", "１２", "12.", ".5"]) expect(parseMajorToMinor(bad, "usd")).toBeNull();
  });

  it("handles zero-decimal currencies", () => {
    expect(parseMajorToMinor("500", "jpy")).toBe(500);
    expect(parseMajorToMinor("500.5", "jpy")).toBeNull();
    expect(formatMoney(500, "jpy")).toBe("¥500");
  });

  it("formats minor units", () => {
    expect(formatMoney(1900, "usd")).toBe("$19");
    expect(formatMoney(1999, "usd")).toBe("$19.99");
    expect(formatMoney(1990, "eur")).toBe("€19.90");
    expect(() => formatMoney(19.5, "usd")).toThrow();
  });

  it("normalises to monthly", () => {
    expect(monthlyEquivalentMinor(1900, "month", 1)).toBe(1900);
    expect(monthlyEquivalentMinor(12000, "year", 1)).toBe(1000);
    expect(monthlyEquivalentMinor(3000, "month", 3)).toBe(1000);
  });

  it("never sums across currencies", () => {
    expect(
      sumByCurrency([
        { amountMinor: 1000, currency: "usd" },
        { amountMinor: 500, currency: "EUR" },
        { amountMinor: 250, currency: "usd" },
      ]),
    ).toEqual({ usd: 1250, eur: 500 });
  });
});
