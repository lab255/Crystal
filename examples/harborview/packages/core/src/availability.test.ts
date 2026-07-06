import { describe, expect, it } from "vitest";
import { searchAvailability } from "./availability";
import type { Sailing } from "./types";

const sailings: Sailing[] = [
  { id: "s1", routeId: "r1", departAt: "2026-08-01T08:00:00Z", seatsAvailable: 3, baseFareCents: 4500 },
  { id: "s2", routeId: "r1", departAt: "2026-08-01T18:00:00Z", seatsAvailable: 1, baseFareCents: 4500 },
  { id: "s3", routeId: "r1", departAt: "2026-08-02T08:00:00Z", seatsAvailable: 5, baseFareCents: 4500 },
];

describe("searchAvailability", () => {
  it("returns sailings on the requested day, sorted by departure", () => {
    const options = searchAvailability(sailings, {
      origin: "A",
      destination: "B",
      date: "2026-08-01",
      passengers: 2,
      fareClass: "economy",
    });
    expect(options.map((o) => o.sailing.id)).toEqual(["s1", "s2"]);
    expect(options[1].soldOut).toBe(true);
  });
});
