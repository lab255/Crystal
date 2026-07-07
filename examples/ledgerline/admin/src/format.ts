import type { Money } from "@ledgerline/shared";

/** "$1,234.50" — minor units to a display string. */
export function formatMoney(money: Money): string {
  const major = money.amount / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: money.currency,
    minimumFractionDigits: 2,
  }).format(major);
}
