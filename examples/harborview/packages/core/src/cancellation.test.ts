import { describe, expect, it } from "vitest";
import { cancellationPenalty, penaltyRate } from "./cancellation";

describe("cancellation policy", () => {
  it("is free more than 48 hours out", () => {
    expect(penaltyRate(72)).toBe(0);
    expect(cancellationPenalty(10000, 72)).toBe(0);
  });

  it("charges half within a day", () => {
    expect(penaltyRate(12)).toBe(0.5);
    expect(cancellationPenalty(10000, 12)).toBe(5000);
  });

  it("forfeits everything at departure", () => {
    expect(cancellationPenalty(10000, 0)).toBe(10000);
  });
});
