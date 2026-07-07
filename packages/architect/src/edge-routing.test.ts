import { describe, expect, it } from "vitest";
import {
  BUSBAR_MIN_EDGES,
  assignLanes,
  busbarPath,
  isBusbarScale,
  roundedPath,
} from "./edge-routing.js";

describe("isBusbarScale", () => {
  it("switches to bus-bars at the threshold", () => {
    expect(isBusbarScale(BUSBAR_MIN_EDGES - 1)).toBe(false);
    expect(isBusbarScale(BUSBAR_MIN_EDGES)).toBe(true);
  });
});

describe("assignLanes", () => {
  const xOf = (id: string) => ({ a: 0, b: 300, c: 600 })[id]!;

  it("bundles a source's fan-out into one lane", () => {
    const lanes = assignLanes(
      [
        { id: "e1", source: "a" },
        { id: "e2", source: "a" },
        { id: "e3", source: "a" },
      ],
      xOf,
    );
    expect(lanes.get("e1")).toBe(lanes.get("e2"));
    expect(lanes.get("e2")).toBe(lanes.get("e3"));
  });

  it("staggers different sources by x order, deterministically", () => {
    const edges = [
      { id: "e-c", source: "c" },
      { id: "e-a", source: "a" },
      { id: "e-b", source: "b" },
    ];
    const lanes = assignLanes(edges, xOf);
    expect(lanes.get("e-a")).toBe(0);
    expect(lanes.get("e-b")).toBe(1);
    expect(lanes.get("e-c")).toBe(2);
    expect([...assignLanes(edges, xOf).entries()]).toEqual([...lanes.entries()]);
  });
});

describe("busbarPath", () => {
  it("routes a downward edge through a bus lane below the source", () => {
    const { path, labelX, labelY } = busbarPath(100, 50, 400, 300, 0);
    expect(path.startsWith("M 100 50")).toBe(true);
    expect(path.endsWith("L 400 300")).toBe(true);
    expect(labelX).toBe(250); // horizontal run midpoint
    expect(labelY).toBe(70); // sy + LANE_BASE for lane 0
  });

  it("staggers the bus by lane", () => {
    const lane0 = busbarPath(100, 50, 400, 300, 0);
    const lane2 = busbarPath(100, 50, 400, 300, 2);
    expect(lane2.labelY).toBeGreaterThan(lane0.labelY);
  });

  it("routes a back edge fully orthogonally (down, across, up)", () => {
    const { path, labelY } = busbarPath(100, 300, 400, 100, 0);
    expect(path.startsWith("M 100 300")).toBe(true);
    expect(path.endsWith("L 400 100")).toBe(true);
    // The bus runs between exit (below source) and approach (above target).
    expect(labelY).toBeGreaterThan(100);
    expect(labelY).toBeLessThan(320);
  });
});

describe("roundedPath", () => {
  it("draws a straight segment for two points", () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe("M 0 0 L 10 0");
  });

  it("rounds corners with quadratic bends", () => {
    const d = roundedPath([
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ]);
    expect(d).toContain("Q 0 100");
    expect(d.endsWith("L 100 100")).toBe(true);
  });

  it("shrinks the bend radius on short segments instead of overshooting", () => {
    const d = roundedPath([
      { x: 0, y: 0 },
      { x: 0, y: 4 },
      { x: 100, y: 4 },
    ]);
    // Radius is capped at half the 4px segment — the bend stays within it.
    expect(d).toContain("L 0 2");
  });
});
