/**
 * Money is always an integer count of the currency's minor unit (e.g. cents).
 * Zero-decimal currencies (JPY, KRW, …) have minor unit = major unit.
 */

export const SUPPORTED_CURRENCIES = ["usd", "eur", "gbp", "cad", "aud", "jpy"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);

export function currencyExponent(currency: string): number {
  return ZERO_DECIMAL.has(currency.toLowerCase()) ? 0 : 2;
}

export function isSupportedCurrency(value: string): value is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value.toLowerCase());
}

/**
 * Parse a user-entered decimal amount ("19", "19.9", "19.99") into minor units without floating point.
 * Returns null for anything that isn't a plain non-negative decimal with at most `exponent` fraction digits.
 */
export function parseMajorToMinor(input: string, currency: string): number | null {
  const exponent = currencyExponent(currency);
  const trimmed = input.trim().replace(/,/g, "");
  const pattern = exponent === 0 ? /^\d{1,9}$/ : new RegExp(`^(\\d{1,9})(?:\\.(\\d{1,${exponent}}))?$`);
  const match = pattern.exec(trimmed);
  if (!match) return null;
  if (exponent === 0) return Number(trimmed);
  const whole = Number(match[1]);
  const fraction = (match[2] ?? "").padEnd(exponent, "0");
  return whole * 10 ** exponent + Number(fraction);
}

export function formatMoney(amountMinor: number, currency: string, locale = "en-US"): string {
  if (!Number.isInteger(amountMinor)) throw new Error("amountMinor must be an integer");
  const exponent = currencyExponent(currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: exponent === 0 || amountMinor % 10 ** exponent !== 0 ? exponent : 0,
    maximumFractionDigits: exponent,
  }).format(amountMinor / 10 ** exponent);
}

/** Plan price bounds in minor units, per currency exponent. */
export function priceBounds(currency: string): { min: number; max: number } {
  return currencyExponent(currency) === 0 ? { min: 100, max: 1_000_000 } : { min: 100, max: 1_000_000 };
}

/** Normalise a recurring amount to a monthly amount (integer, rounded half up). */
export function monthlyEquivalentMinor(amountMinor: number, interval: string, intervalCount: number): number {
  switch (interval) {
    case "month":
      return Math.round(amountMinor / intervalCount);
    case "year":
      return Math.round(amountMinor / (12 * intervalCount));
    case "week":
      return Math.round((amountMinor * 52) / (12 * intervalCount));
    case "day":
      return Math.round((amountMinor * 365) / (12 * intervalCount));
    default:
      throw new Error(`Unknown interval ${interval}`);
  }
}

/** Sum amounts grouped by currency; never adds across currencies. */
export function sumByCurrency(items: { amountMinor: number; currency: string }[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const item of items) {
    const c = item.currency.toLowerCase();
    totals[c] = (totals[c] ?? 0) + item.amountMinor;
  }
  return totals;
}
