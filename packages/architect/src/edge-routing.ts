/**
 * Orthogonal "bus-bar" edge routing for diagrams past the curve-friendly
 * scale. Bezier curves read well up to a dozen dependencies; beyond that the
 * canvas needs sorted, snapped, straight runs. Every edge routes source →
 * vertical drop → horizontal bus → vertical drop → target. Edges leaving the
 * same node share one lane, so a node's fan-out overlaps into a single
 * horizontal trunk with branches — the bus-bar look — and different sources
 * get staggered lanes so their buses don't merge into ambiguity.
 *
 * Pure math (no react-flow imports) so routing is unit-testable.
 */

/** Diagram edge count at which routing switches from curves to bus-bars. */
export const BUSBAR_MIN_EDGES = 12;

/** Vertical clearance from a source's bottom edge to its bus lane. */
const LANE_BASE = 20;
/** Lane stagger between different sources sharing a channel. */
const LANE_STEP = 10;
/** Lanes cycle after this many distinct sources (buses far apart can share). */
const LANE_CYCLE = 6;
/** Corner radius of the orthogonal bends. */
const BEND_R = 6;

export function isBusbarScale(edgeCount: number): boolean {
  return edgeCount >= BUSBAR_MIN_EDGES;
}

/**
 * Stable lane per edge, bundled by source node: all of a node's outgoing
 * edges get the same lane (their trunks overlap into one bus); sources are
 * ranked by x then id so lanes are deterministic across renders.
 */
export function assignLanes(
  edges: readonly { id: string; source: string }[],
  xOf: (nodeId: string) => number,
): Map<string, number> {
  const sources = [...new Set(edges.map((e) => e.source))].sort(
    (a, b) => xOf(a) - xOf(b) || (a < b ? -1 : 1),
  );
  const laneOfSource = new Map(sources.map((s, i) => [s, i % LANE_CYCLE]));
  return new Map(edges.map((e) => [e.id, laneOfSource.get(e.source) ?? 0]));
}

/**
 * Rounded orthogonal path for one edge (TB handles: out the source's bottom,
 * into the target's top), plus the label anchor on the bus segment.
 *
 * Downward edges: drop to the bus lane, run across, drop into the target.
 * Upward (back) edges: drop below the source, run across, rise into the
 * target from its own approach lane — still fully orthogonal.
 */
export function busbarPath(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  lane: number,
): { path: string; labelX: number; labelY: number } {
  const laneOffset = LANE_BASE + lane * LANE_STEP;

  if (ty >= sy + laneOffset * 2) {
    // Forward (downward): one bus lane below the source.
    const busY = sy + laneOffset;
    return {
      path: roundedPath([
        { x: sx, y: sy },
        { x: sx, y: busY },
        { x: tx, y: busY },
        { x: tx, y: ty },
      ]),
      labelX: (sx + tx) / 2,
      labelY: busY,
    };
  }

  // Back edge: exit downward, run across on the exit lane, approach the
  // target from above on its own lane.
  const exitY = sy + laneOffset;
  const approachY = ty - LANE_BASE - lane * LANE_STEP;
  const midX = (sx + tx) / 2;
  return {
    path: roundedPath([
      { x: sx, y: sy },
      { x: sx, y: exitY },
      { x: midX, y: exitY },
      { x: midX, y: approachY },
      { x: tx, y: approachY },
      { x: tx, y: ty },
    ]),
    labelX: midX,
    labelY: (exitY + approachY) / 2,
  };
}

/** SVG path through orthogonal waypoints with rounded bends. */
export function roundedPath(points: readonly { x: number; y: number }[]): string {
  if (points.length < 2) return "";
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    // Radius shrinks on short segments so bends never overshoot.
    const r = Math.min(
      BEND_R,
      Math.hypot(cur.x - prev.x, cur.y - prev.y) / 2,
      Math.hypot(next.x - cur.x, next.y - cur.y) / 2,
    );
    if (r < 0.5) {
      d += ` L ${cur.x} ${cur.y}`;
      continue;
    }
    const inX = Math.sign(cur.x - prev.x);
    const inY = Math.sign(cur.y - prev.y);
    const outX = Math.sign(next.x - cur.x);
    const outY = Math.sign(next.y - cur.y);
    d += ` L ${cur.x - inX * r} ${cur.y - inY * r}`;
    d += ` Q ${cur.x} ${cur.y} ${cur.x + outX * r} ${cur.y + outY * r}`;
  }
  const last = points[points.length - 1]!;
  d += ` L ${last.x} ${last.y}`;
  return d;
}
