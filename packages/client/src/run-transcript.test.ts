import { describe, expect, it } from "vitest";
import { formatRunCost, formatRunDuration, formatRunTokens } from "./run-transcript.js";

/**
 * The run formatters are shared by the orchestrator (run rows, task cost) and
 * the hub (program and delivery spend), so their edge cases are worth pinning:
 * "unknown" and "zero" are different states and must not render the same.
 */
describe("formatRunCost", () => {
  it("distinguishes unknown, zero and too-small-to-show", () => {
    expect(formatRunCost(null)).toBe("—");
    expect(formatRunCost(undefined)).toBe("—");
    // A program whose deliveries have not started cost nothing — saying
    // "<$0.01" would overstate it.
    expect(formatRunCost(0)).toBe("$0.00");
    expect(formatRunCost(0.004)).toBe("<$0.01");
    expect(formatRunCost(0.01)).toBe("$0.01");
    expect(formatRunCost(12.345)).toBe("$12.35");
  });
});

describe("formatRunTokens", () => {
  it("scales into k and M, and treats zero as nothing to show", () => {
    expect(formatRunTokens(null)).toBe("—");
    expect(formatRunTokens(0)).toBe("—");
    expect(formatRunTokens(999)).toBe("999");
    expect(formatRunTokens(1500)).toBe("1.5k");
    expect(formatRunTokens(12_000)).toBe("12k");
    expect(formatRunTokens(2_500_000)).toBe("2.5M");
  });
});

describe("formatRunDuration", () => {
  it("steps from milliseconds to minutes", () => {
    expect(formatRunDuration(null)).toBe("—");
    expect(formatRunDuration(450)).toBe("450ms");
    expect(formatRunDuration(1500)).toBe("2s");
    expect(formatRunDuration(59_000)).toBe("59s");
    expect(formatRunDuration(125_000)).toBe("2m 5s");
  });
});
