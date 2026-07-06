import type { Passenger } from "./types";
import { clamp } from "./util";

export interface PromoRule {
  code: string;
  rate: number;
  minPassengers: number;
}

export const PROMOS: PromoRule[] = [
  { code: "EARLYBIRD", rate: 0.1, minPassengers: 1 },
  { code: "GROUP4", rate: 0.2, minPassengers: 4 },
  { code: "LOCALS", rate: 0.15, minPassengers: 1 },
];

export function findPromo(code: string | undefined): PromoRule | undefined {
  if (!code) return undefined;
  return PROMOS.find((promo) => promo.code === code.toUpperCase());
}

export function applyDiscounts(
  subtotalCents: number,
  passengers: Passenger[],
  promoCode?: string,
): number {
  const promo = findPromo(promoCode);
  if (!promo) return 0;
  if (passengers.length < promo.minPassengers) return 0;
  const raw = subtotalCents * promo.rate;
  return Math.round(clamp(raw, 0, subtotalCents));
}
