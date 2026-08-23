import { describe, expect, it } from "vitest";
import {
  countRouteCrossings,
  describeMessiness,
  isMessinessDebugEnabled,
  layoutMessiness,
  LAYOUT_MESSINESS_HIDE_THRESHOLD,
  LAYOUT_MESSINESS_THRESHOLD,
  shouldOfferMessyLayout,
} from "./layout-messiness.js";

const base = { nodes: 10, edges: 10, crossings: 0, labelOverlaps: 0, extremeAspects: 0 };

describe("layoutMessiness", () => {
  it("stays bounded and gives clean layouts a zero score", () => {
    expect(layoutMessiness(base)).toBe(0);
    expect(layoutMessiness({ ...base, crossings: 1_000, labelOverlaps: 1_000 })).toBeCloseTo(0.82);
  });

  it("normalizes crossings and combines label, aspect, and pin pressure", () => {
    expect(layoutMessiness({ ...base, crossings: 10 })).toBeCloseTo(0.1675);
    expect(layoutMessiness({ ...base, labelOverlaps: 10, extremeAspects: 10, pinBrokenRoutes: 10 })).toBeCloseTo(0.65);
  });

  it("crosses the offer threshold only for material tangling", () => {
    expect(layoutMessiness({ ...base, crossings: 20 })).toBeLessThan(LAYOUT_MESSINESS_THRESHOLD);
    expect(layoutMessiness({ ...base, crossings: 21 })).toBeGreaterThanOrEqual(LAYOUT_MESSINESS_THRESHOLD);
  });

  it("requires a useful re-layout action before offering", () => {
    expect(shouldOfferMessyLayout(LAYOUT_MESSINESS_THRESHOLD, false, 0)).toBe(true);
    expect(shouldOfferMessyLayout(LAYOUT_MESSINESS_THRESHOLD, true, 0)).toBe(false);
    expect(shouldOfferMessyLayout(LAYOUT_MESSINESS_THRESHOLD, true, 1)).toBe(true);
    expect(shouldOfferMessyLayout(LAYOUT_MESSINESS_HIDE_THRESHOLD, false, 0, true)).toBe(true);
    expect(shouldOfferMessyLayout(LAYOUT_MESSINESS_HIDE_THRESHOLD, false, 0)).toBe(false);
  });

  it("formats a dependency-free debug report", () => {
    expect(describeMessiness({ ...base, crossings: null, pinBrokenRoutes: 2, score: 0.42 }))
      .toMatchInlineSnapshot(`
        "score              0.420
        crossings          capped
        label overlaps     0
        extreme aspects    0
        pin-broken routes  2"
      `);
    expect(isMessinessDebugEnabled({ getItem: () => "true" })).toBe(true);
    expect(isMessinessDebugEnabled({ getItem: () => null })).toBe(false);
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
