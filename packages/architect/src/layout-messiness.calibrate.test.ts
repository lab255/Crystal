import { describe, expect, it } from "vitest";
import { messinessFixtures } from "./__fixtures__/messiness/index.js";
import { elkAutoLayout } from "./elk-layout.js";
import {
  layoutMessiness,
  LAYOUT_MESSINESS_THRESHOLD,
  type LayoutMessinessMetrics,
} from "./layout-messiness.js";

describe("layout messiness calibration", () => {
  it("orders synthetic repositories through the real ELK pipeline", async () => {
    const entries = await Promise.all(Object.entries(messinessFixtures).map(async ([name, build]) => {
      const fixture = build();
      const result = await elkAutoLayout(fixture.graph, { dims: fixture.dims });
      const metrics = { ...result.metrics, pinBrokenRoutes: fixture.pinBrokenRoutes ?? 0 };
      return [name, { ...metrics, score: layoutMessiness(metrics) }] as const;
    }));
    const scores = Object.fromEntries(entries) as unknown as Record<
      keyof typeof messinessFixtures,
      LayoutMessinessMetrics & { score: number }
    >;
    expect(scores.overlappingLabels.labelOverlaps).toBeGreaterThan(0);
    expect(scores.extremeAspect.extremeAspects).toBeGreaterThan(0);
    expect(scores.clean.score).toBeLessThan(scores.medium.score);
    expect(scores.medium.score).toBeLessThan(scores.tangle.score);
    expect(scores.clean.score).toBeLessThanOrEqual(0.25);
    expect(scores.clean.score).toBeLessThan(LAYOUT_MESSINESS_THRESHOLD);
    expect(scores.tangle.crossings! / (scores.tangle.edges * 4)).toBeGreaterThan(0.6);
    expect(scores.tangle.crossings! / (scores.tangle.edges * 4)).toBeLessThan(0.8);
    expect(scores.tangle.score).toBeGreaterThanOrEqual(LAYOUT_MESSINESS_THRESHOLD + 0.1);
    expect(scores.pinnedBroken.score).toBeGreaterThan(scores.tangle.score);
  }, 60_000);
});
