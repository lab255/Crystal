import { describe, expect, it } from "vitest";
import {
  countRouteCrossings,
  layoutMessiness,
  LAYOUT_MESSINESS_THRESHOLD,
  shouldOfferMessyLayout,
} from "./layout-messiness.js";

const base = { nodes: 10, edges: 10, crossings: 0, labelOverlaps: 0, extremeAspects: 0 };

describe("layoutMessiness", () => {
  it("stays bounded and gives clean layouts a zero score", () => {
    expect(layoutMessiness(base)).toBe(0);
    expect(layoutMessiness({ ...base, crossings: 1_000, labelOverlaps: 1_000 })).toBe(0.75);
  });

  it("normalizes crossings and combines label, aspect, and pin pressure", () => {
    expect(layoutMessiness({ ...base, crossings: 10 })).toBeCloseTo(0.45);
    expect(layoutMessiness({ ...base, labelOverlaps: 10, extremeAspects: 10, pinBrokenRoutes: 10 })).toBeCloseTo(0.8);
  });

  it("crosses the offer threshold only for material tangling", () => {
    expect(layoutMessiness({ ...base, crossings: 7 })).toBeLessThan(LAYOUT_MESSINESS_THRESHOLD);
    expect(layoutMessiness({ ...base, crossings: 8 })).toBeGreaterThanOrEqual(LAYOUT_MESSINESS_THRESHOLD);
  });

  it("requires a useful re-layout action before offering", () => {
    expect(shouldOfferMessyLayout(LAYOUT_MESSINESS_THRESHOLD, false, 0)).toBe(true);
    expect(shouldOfferMessyLayout(LAYOUT_MESSINESS_THRESHOLD, true, 0)).toBe(false);
    expect(shouldOfferMessyLayout(LAYOUT_MESSINESS_THRESHOLD, true, 1)).toBe(true);
  });
});

describe("countRouteCrossings", () => {
  it("counts proper intersections between synthetic routes", () => {
    const routes = new Map([
      ["a", { points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }],
      ["b", { points: [{ x: 0, y: 10 }, { x: 10, y: 0 }] }],
    ]);
    expect(countRouteCrossings(routes)).toBe(1);
  });

  it("skips route pairs with shared endpoints and caps work", () => {
    const shared = new Map([
      ["a", { points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }],
      ["b", { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }],
    ]);
    expect(countRouteCrossings(shared)).toBe(0);
    expect(countRouteCrossings(shared, 1)).toBeNull();
  });
});
