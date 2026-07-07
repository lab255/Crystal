import { describe, expect, it } from "vitest";
import { resolveCollisions, type DisplaceRect } from "./displace.js";

const rect = (
  id: string,
  x: number,
  y: number,
  width = 200,
  height = 84,
  fixed = false,
): DisplaceRect => ({ id, x, y, width, height, fixed });

function applied(rects: DisplaceRect[], gap = 24) {
  const offsets = resolveCollisions(rects, gap);
  return rects.map((r) => {
    const o = offsets.get(r.id);
    return { ...r, x: r.x + (o?.dx ?? 0), y: r.y + (o?.dy ?? 0) };
  });
}

function overlaps(a: DisplaceRect, b: DisplaceRect, gap: number): boolean {
  return (
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) + gap > 0 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) + gap > 0
  );
}

describe("resolveCollisions", () => {
  it("returns nothing when rects are already clear", () => {
    const offsets = resolveCollisions([rect("a", 0, 0), rect("b", 400, 0)]);
    expect(offsets.size).toBe(0);
  });

  it("a fixed (expanded) rect pushes a movable sibling clear, and never moves itself", () => {
    // Expanded container grew over the leaf to its right.
    const rects = [rect("big", 0, 0, 800, 600, true), rect("leaf", 300, 100)];
    const offsets = resolveCollisions(rects);
    expect(offsets.has("big")).toBe(false);
    const out = applied(rects);
    expect(overlaps(out[0]!, out[1]!, 24)).toBe(false);
  });

  it("two movable rects split the separation along the cheaper axis", () => {
    // Shallow horizontal brush (20px) vs full vertical overlap → X is cheaper.
    const rects = [rect("a", 0, 0), rect("b", 180, 0)];
    const offsets = resolveCollisions(rects);
    expect(offsets.get("a")!.dx).toBeLessThan(0);
    expect(offsets.get("b")!.dx).toBeGreaterThan(0);
    const out = applied(rects);
    expect(overlaps(out[0]!, out[1]!, 24)).toBe(false);
  });

  it("cascades: a push that causes a new overlap resolves in later passes", () => {
    const rects = [
      rect("big", 0, 0, 800, 600, true),
      rect("a", 700, 200), // pushed right by big…
      rect("b", 940, 200), // …into b, which must then also move
    ];
    const out = applied(rects);
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(overlaps(out[i]!, out[j]!, 24)).toBe(false);
      }
    }
  });

  it("is deterministic", () => {
    const rects = [rect("big", 0, 0, 500, 500, true), rect("a", 300, 100), rect("b", 300, 300)];
    const one = resolveCollisions(rects);
    const two = resolveCollisions(rects);
    expect([...one.entries()]).toEqual([...two.entries()]);
  });
});
