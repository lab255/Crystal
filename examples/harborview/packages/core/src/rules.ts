import type { FareClass } from "./types";

export const CLASS_MULTIPLIERS: Record<FareClass, number> = {
  economy: 1,
  premium: 1.6,
  vehicle: 2.4,
};

export const PEAK_SURCHARGE = 0.25;
export const WEEKEND_SURCHARGE = 0.15;

export function classMultiplier(fareClass: FareClass): number {
  return CLASS_MULTIPLIERS[fareClass] ?? 1;
}

export function isPeak(departAt: string): boolean {
  const hour = new Date(departAt).getUTCHours();
  return hour >= 7 && hour <= 9;
}

export function isWeekend(departAt: string): boolean {
  const day = new Date(departAt).getUTCDay();
  return day === 0 || day === 6;
}

export function surchargeRate(departAt: string): number {
  let rate = 0;
  if (isPeak(departAt)) rate += PEAK_SURCHARGE;
  if (isWeekend(departAt)) rate += WEEKEND_SURCHARGE;
  return rate;
}
