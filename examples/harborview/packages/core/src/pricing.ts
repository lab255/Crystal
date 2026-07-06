import type { QuoteRequest, FareQuote, FareLine } from "./types";
import * as rules from "./rules";
import { applyDiscounts } from "./discounts";
import { roundCents } from "./util";

export function quoteFare(request: QuoteRequest): FareQuote {
  const lines: FareLine[] = [];
  const surcharge = rules.surchargeRate(request.departAt);
  let subtotal = 0;

  for (const passenger of request.passengers) {
    const multiplier = rules.classMultiplier(passenger.fareClass);
    const base = request.baseFareCents * multiplier;
    const withSurcharge = base * (1 + surcharge);
    const amount = roundCents(withSurcharge);
    subtotal += amount;
    lines.push({
      label: passenger.fullName + " (" + passenger.fareClass + ")",
      amountCents: amount,
    });
  }

  const discount = applyDiscounts(subtotal, request.passengers, request.promoCode);
  if (discount > 0) {
    lines.push({ label: "Promo " + request.promoCode, amountCents: -discount });
  }

  return {
    currency: "USD",
    lines,
    subtotalCents: subtotal,
    discountCents: discount,
    totalCents: subtotal - discount,
  };
}
