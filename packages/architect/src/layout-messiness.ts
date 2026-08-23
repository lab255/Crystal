export interface LayoutMessinessMetrics {
  nodes: number;
  edges: number;
  crossings: number | null;
  labelOverlaps: number;
  avgEdgeLength?: number;
  extremeAspects: number;
  pinBrokenRoutes?: number;
}

export interface RouteForCrossings {
  points: readonly { x: number; y: number }[];
}

export const LAYOUT_MESSINESS_THRESHOLD = 0.35;
export const LAYOUT_MESSINESS_HIDE_THRESHOLD = 0.28;
export const MAX_CROSSING_SEGMENTS = 2_000;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** C4 re-layout only has an effect when the current view has pins to clear. */
export function shouldOfferMessyLayout(
  score: number,
  c4Enabled: boolean,
  pinCount: number,
  currentlyShown = false,
): boolean {
  const threshold = currentlyShown
    ? LAYOUT_MESSINESS_HIDE_THRESHOLD
    : LAYOUT_MESSINESS_THRESHOLD;
  return score >= threshold && (!c4Enabled || pinCount > 0);
}

/** A stable, bounded score suitable for deciding whether re-layout is worth offering. */
export function layoutMessiness(metrics: LayoutMessinessMetrics): number {
  const edges = Math.max(1, metrics.edges);
  const nodes = Math.max(1, metrics.nodes);
  // A crossing per edge is common in merely busy layered graphs. Four per
  // edge is the calibrated saturation point that separates those from tangles.
  const crossings = metrics.crossings == null ? 0 : clamp01(metrics.crossings / (edges * 4));
  const labels = clamp01(metrics.labelOverlaps / edges);
  const extreme = clamp01(metrics.extremeAspects / nodes);
  const brokenPins = clamp01((metrics.pinBrokenRoutes ?? 0) / edges);
  // Crossings lead because calibration tangles become costly well before the
  // normalization clamp. The deliberate 1.32 total lets combined signals saturate.
  return clamp01(crossings * 0.67 + labels * 0.15 + extreme * 0.15 + brokenPins * 0.35);
}

export function isMessinessDebugEnabled(storage: Pick<Storage, "getItem"> | undefined =
  typeof localStorage === "undefined" ? undefined : localStorage): boolean {
  try {
    return storage?.getItem("crystal.debug.messiness") === "true";
  } catch {
    return false;
  }
}

export function describeMessiness(metrics: LayoutMessinessMetrics & { score?: number }): string {
  const score = metrics.score ?? layoutMessiness(metrics);
  const cells: [string, string][] = [
    ["score", score.toFixed(3)],
    ["crossings", metrics.crossings == null ? "capped" : String(metrics.crossings)],
    ["label overlaps", String(metrics.labelOverlaps)],
    ["extreme aspects", String(metrics.extremeAspects)],
    ["pin-broken routes", String(metrics.pinBrokenRoutes ?? 0)],
  ];
  const width = Math.max(...cells.map(([label]) => label.length));
  return cells.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n");
}

function samePoint(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x === b.x && a.y === b.y;
}

function shareEndpoint(a: RouteForCrossings, b: RouteForCrossings): boolean {
  const aEnds = [a.points[0], a.points.at(-1)].filter((point) => point != null);
  const bEnds = [b.points[0], b.points.at(-1)].filter((point) => point != null);
  return aEnds.some((left) => bEnds.some((right) => samePoint(left, right)));
}

function properIntersection(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number },
): boolean {
  const cross = (p: typeof a, q: typeof a, r: typeof a): number =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  // Endpoint touches and collinear runs are not crossings.
  return abC * abD < 0 && cdA * cdB < 0;
}

/** Counts crossings between different routes, with a hard cap on quadratic work. */
export function countRouteCrossings(
  routes: ReadonlyMap<string, RouteForCrossings>,
  maxSegments = MAX_CROSSING_SEGMENTS,
): number | null {
  const entries = [...routes.values()].map((route) => ({
    route,
    segments: route.points.slice(1).map((to, index) => [route.points[index]!, to] as const),
  }));
  const segmentCount = entries.reduce((sum, entry) => sum + entry.segments.length, 0);
  if (segmentCount > maxSegments) return null;

  let crossings = 0;
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const a = entries[left]!;
      const b = entries[right]!;
      if (shareEndpoint(a.route, b.route)) continue;
      for (const [aFrom, aTo] of a.segments) {
        for (const [bFrom, bTo] of b.segments) {
          if (properIntersection(aFrom, aTo, bFrom, bTo)) crossings += 1;
        }
      }
    }
  }
  return crossings;
}
