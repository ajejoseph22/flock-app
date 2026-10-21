import { formatMoney } from "@flock/core/domain/money";

export { formatMoney };

const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export const formatDate = (d: Date | null | undefined) => (d ? dateFmt.format(d) : "—");
export const formatDateTime = (d: Date | null | undefined) => (d ? `${dateTimeFmt.format(d)} UTC` : "—");

export function formatMoneyByCurrency(totals: Record<string, number>): string {
  const entries = Object.entries(totals);
  if (entries.length === 0) return formatMoney(0, "usd");
  return entries.map(([currency, amount]) => formatMoney(amount, currency)).join(" · ");
}

