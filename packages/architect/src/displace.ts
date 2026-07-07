/**
 * Ephemeral overlap removal: when an expanded node's live-code content
 * outgrows the space its layout slot reserved, neighboring nodes are pushed
 * aside — as view-only offsets, never written to the graph. Collapse the node
 * and everything slides home. This is the safety net under pre-allocated
 * layouts (which usually make displacement a no-op) and the whole mechanism
 * for hand-arranged diagrams.
 */

export interface DisplaceRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Fixed rects (the expanded nodes) never move — others yield to them. */
  fixed?: boolean;
}

export interface Offset {
  dx: number;
  dy: number;
}

/**
 * Push movable rects apart until nothing overlaps (with `gap` clearance).
 * Iterative pairwise separation along the axis of least penetration —
 * deterministic (pairs visited in input order), bounded by `maxPasses`.
 * Returns offsets only for rects that actually moved.
 */
export function resolveCollisions(
  rects: readonly DisplaceRect[],
  gap = 24,
  maxPasses = 8,
): Map<string, Offset> {
  const work = rects.map((r) => ({ ...r }));

  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (let i = 0; i < work.length; i++) {
      for (let j = i + 1; j < work.length; j++) {
        const a = work[i]!;
        const b = work[j]!;
        if (a.fixed && b.fixed) continue;

        // Penetration depth on each axis, including the clearance gap.
        const overlapX =
          Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) + gap;
        const overlapY =
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) + gap;
        if (overlapX <= 0 || overlapY <= 0) continue;

        // Separate along the cheaper axis, away from the other rect's center.
        const alongX = overlapX <= overlapY;
        const aCenter = alongX ? a.x + a.width / 2 : a.y + a.height / 2;
        const bCenter = alongX ? b.x + b.width / 2 : b.y + b.height / 2;
        const push = alongX ? overlapX : overlapY;
        // Ties (identical centers) break toward moving `b` positive.
        const sign = bCenter >= aCenter ? 1 : -1;

        const shift = (r: { fixed?: boolean } & DisplaceRect, amount: number) => {
          if (alongX) r.x += amount;
          else r.y += amount;
        };
        if (a.fixed) shift(b, sign * push);
        else if (b.fixed) shift(a, -sign * push);
        else {
          shift(a, -sign * (push / 2));
          shift(b, sign * (push / 2));
        }
        moved = true;
      }
    }
    if (!moved) break;
  }

  const offsets = new Map<string, Offset>();
  for (let i = 0; i < work.length; i++) {
    const dx = work[i]!.x - rects[i]!.x;
    const dy = work[i]!.y - rects[i]!.y;
    if (dx !== 0 || dy !== 0) offsets.set(work[i]!.id, { dx, dy });
  }
  return offsets;
}
