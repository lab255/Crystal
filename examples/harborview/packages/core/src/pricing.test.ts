import { describe, expect, it } from "vitest";
import { quoteFare } from "./pricing";

describe("quoteFare", () => {
  it("charges base fare for a single economy passenger off-peak", () => {
    const quote = quoteFare({
      sailingId: "sail_1",
      baseFareCents: 4500,
      departAt: "2026-08-05T12:00:00Z",
      passengers: [{ fullName: "Ada", email: "ada@example.com", fareClass: "economy" }],
    });
    expect(quote.subtotalCents).toBe(4500);
    expect(quote.totalCents).toBe(4500);
  });

  it("applies a group discount for four passengers with GROUP4", () => {
    const passengers = Array.from({ length: 4 }, (_, i) => ({
      fullName: "Rider " + i,
      email: "rider" + i + "@example.com",
      fareClass: "economy" as const,
    }));
    const quote = quoteFare({
      sailingId: "sail_1",
      baseFareCents: 5000,
      departAt: "2026-08-05T12:00:00Z",
      passengers,
      promoCode: "GROUP4",
    });
    expect(quote.discountCents).toBe(4000);
    expect(quote.totalCents).toBe(16000);
  });
});
