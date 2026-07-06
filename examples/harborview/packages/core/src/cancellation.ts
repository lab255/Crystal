import { clamp } from "./util";

export interface CancellationTier {
  minHours: number;
  penaltyRate: number;
}

export const CANCELLATION_TIERS: CancellationTier[] = [
  { minHours: 48, penaltyRate: 0 },
  { minHours: 24, penaltyRate: 0.25 },
  { minHours: 2, penaltyRate: 0.5 },
  { minHours: 0, penaltyRate: 1 },
];

export function penaltyRate(hoursBeforeDeparture: number): number {
  for (const tier of CANCELLATION_TIERS) {
    if (hoursBeforeDeparture >= tier.minHours) {
      return tier.penaltyRate;
    }
  }
  return 1;
}

export function cancellationPenalty(totalCents: number, hoursBeforeDeparture: number): number {
  const rate = penaltyRate(hoursBeforeDeparture);
  return Math.round(clamp(totalCents * rate, 0, totalCents));
}
