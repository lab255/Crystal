import type { Sailing, FareClass } from "./types";

export interface AvailabilityQuery {
  origin: string;
  destination: string;
  date: string;
  passengers: number;
  fareClass: FareClass;
}

export interface AvailabilityOption {
  sailing: Sailing;
  seatsLeft: number;
  soldOut: boolean;
}

export function matchesQuery(sailing: Sailing, query: AvailabilityQuery): boolean {
  const sameDay = sailing.departAt.slice(0, 10) === query.date;
  return sameDay && sailing.seatsAvailable >= 0;
}

export function searchAvailability(
  sailings: Sailing[],
  query: AvailabilityQuery,
): AvailabilityOption[] {
  return sailings
    .filter((sailing) => matchesQuery(sailing, query))
    .map((sailing) => ({
      sailing,
      seatsLeft: sailing.seatsAvailable,
      soldOut: sailing.seatsAvailable < query.passengers,
    }))
    .sort((a, b) => a.sailing.departAt.localeCompare(b.sailing.departAt));
}
