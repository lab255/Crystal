import type { SystemLink, SystemModule, SystemOverview, SystemRole } from "./system-overview.js";

/**
 * System insights — the judgement layer over the system overview. Where
 * `buildSystemOverview` answers *what exists and how it connects*, this
 * answers the review questions an architect actually asks of that graph:
 * where are the cycles, which dependencies point the wrong way through the
 * layers, what has become a hub, and what is dead weight. All pure and
 * deterministic over one `SystemOverview` (or two, for the ref diff).
 */

/* ------------------------------------------------------------------ */
/* Insights                                                            */
/* ------------------------------------------------------------------ */

/** A dependency cycle: two or more systems that import each other. */
export interface SystemCycle {
  /** Member system ids (sorted). */
  ids: string[];
  names: string[];
  /** Total import weight on the edges inside the cycle. */
  weight: number;
  /** The cycle's edges, for highlighting. */
  edges: { source: string; target: string }[];
}

export const VIOLATION_KINDS = ["upward", "entry-import"] as const;
export type ViolationKind = (typeof VIOLATION_KINDS)[number];

/** A dependency pointing the wrong way through the role layers. */
export interface LayeringViolation {
  kind: ViolationKind;
  source: string;
  sourceName: string;
  target: string;
  targetName: string;
  weight: number;
  symbols: string[];
  /** One-line reviewer-facing explanation. */
  detail: string;
}

export interface SystemMetrics {
  id: string;
  name: string;
  /** Distinct systems importing this one / imported by this one. */
  fanIn: number;
  fanOut: number;
  /** Import statements in / out. */
  inWeight: number;
  outWeight: number;
  /**
   * Instability I = Ce / (Ca + Ce) — 0 = everything depends on it (stable),
   * 1 = it depends on everything (volatile). Null for disconnected systems.
   */
  instability: number | null;
}

export interface SystemInsights {
  cycles: SystemCycle[];
  violations: LayeringViolation[];
  /** Systems whose degree makes them coupling hot-spots (worst first). */
  hubs: { id: string; name: string; degree: number }[];
  /** Non-entry systems with no links at all. */
  orphans: { id: string; name: string; fileCount: number }[];
  /** Per-system coupling metrics, highest degree first. */
  metrics: SystemMetrics[];
  /** cycles + violations (the reviewer's "how bad is it" number). */
  total: number;
}

/** A hub needs at least this many linked neighbours. */
const HUB_MIN_DEGREE = 6;
/** …and at least this share of the other systems as neighbours. */
const HUB_DEGREE_SHARE = 0.5;
const CYCLES_CAP = 12;

/** Tarjan strongly-connected components over the link graph. */
function stronglyConnected(ids: string[], links: readonly SystemLink[]): string[][] {
  const adjacency = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const l of links) {
    if (l.source !== l.target && adjacency.has(l.source) && adjacency.has(l.target)) {
      adjacency.get(l.source)!.push(l.target);
    }
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  // Iterative Tarjan — deep graphs must not blow the call stack.
  const iterate = (root: string): void => {
    const work: { node: string; edgeIndex: number }[] = [{ node: root, edgeIndex: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const { node } = frame;
      if (frame.edgeIndex === 0) {
        index.set(node, counter);
        low.set(node, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node);
      }
      const neighbours = adjacency.get(node)!;
      let descended = false;
      while (frame.edgeIndex < neighbours.length) {
        const next = neighbours[frame.edgeIndex]!;
        frame.edgeIndex += 1;
        if (!index.has(next)) {
          work.push({ node: next, edgeIndex: 0 });
          descended = true;
          break;
        }
        if (onStack.has(next)) low.set(node, Math.min(low.get(node)!, index.get(next)!));
      }
      if (descended) continue;
      if (low.get(node) === index.get(node)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop()!;
          onStack.delete(popped);
          component.push(popped);
          if (popped === node) break;
        }
        if (component.length > 1) components.push(component);
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(node)!));
    }
  };
  for (const id of ids) if (!index.has(id)) iterate(id);
  return components;
}

/** Compute review insights over one overview. Pure and deterministic. */
export function computeSystemInsights(overview: SystemOverview): SystemInsights {
  const systems = overview.systems;
  const byId = new Map(systems.map((s) => [s.id, s]));
  const nameOf = (id: string): string => byId.get(id)?.name ?? id;
  const links = overview.links.filter((l) => byId.has(l.source) && byId.has(l.target));

  // Cycles.
  const components = stronglyConnected(
    systems.map((s) => s.id),
    links,
  );
  const cycles: SystemCycle[] = components
    .map((ids) => {
      const members = new Set(ids);
      const edges = links
        .filter((l) => members.has(l.source) && members.has(l.target) && l.source !== l.target)
        .map((l) => ({ source: l.source, target: l.target }));
      const weight = links
        .filter((l) => members.has(l.source) && members.has(l.target))
        .reduce((n, l) => n + l.weight, 0);
      const sorted = [...ids].sort();
      return { ids: sorted, names: sorted.map(nameOf), weight, edges };
    })
    .sort((a, b) => b.weight - a.weight || a.ids.join().localeCompare(b.ids.join()))
    .slice(0, CYCLES_CAP);

  // Layering violations.
  const violations: LayeringViolation[] = [];
  const lower: readonly SystemRole[] = ["shared", "data"];
  const feature: readonly SystemRole[] = ["domain", "integration"];
  for (const l of links) {
    const source = byId.get(l.source)!;
    const target = byId.get(l.target)!;
    const base = {
      source: source.id,
      sourceName: source.name,
      target: target.id,
      targetName: target.name,
      weight: l.weight,
      symbols: l.symbols,
    };
    if (lower.includes(source.role) && feature.includes(target.role)) {
      violations.push({
        ...base,
        kind: "upward",
        detail: `${source.name} (${source.role}) reaches up into ${target.name} — the ${source.role} layer should not know about feature code`,
      });
    } else if (target.role === "entry" && source.role !== "entry") {
      violations.push({
        ...base,
        kind: "entry-import",
        detail: `${source.name} imports from ${target.name} — entry layers (routes, pages) should sit on top, not be depended on`,
      });
    }
  }
  violations.sort((a, b) => b.weight - a.weight || a.sourceName.localeCompare(b.sourceName));

  // Metrics, hubs, orphans.
  const inSets = new Map<string, Set<string>>();
  const outSets = new Map<string, Set<string>>();
  const inWeight = new Map<string, number>();
  const outWeight = new Map<string, number>();
  for (const l of links) {
    if (l.source === l.target) continue;
    (outSets.get(l.source) ?? outSets.set(l.source, new Set()).get(l.source)!).add(l.target);
    (inSets.get(l.target) ?? inSets.set(l.target, new Set()).get(l.target)!).add(l.source);
    outWeight.set(l.source, (outWeight.get(l.source) ?? 0) + l.weight);
    inWeight.set(l.target, (inWeight.get(l.target) ?? 0) + l.weight);
  }
  const metrics: SystemMetrics[] = systems
    .map((s) => {
      const fanIn = inSets.get(s.id)?.size ?? 0;
      const fanOut = outSets.get(s.id)?.size ?? 0;
      return {
        id: s.id,
        name: s.name,
        fanIn,
        fanOut,
        inWeight: inWeight.get(s.id) ?? 0,
        outWeight: outWeight.get(s.id) ?? 0,
        instability:
          fanIn + fanOut === 0 ? null : Math.round((fanOut / (fanIn + fanOut)) * 100) / 100,
      };
    })
    .sort(
      (a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut) || a.name.localeCompare(b.name),
    );

  const hubThreshold = Math.max(HUB_MIN_DEGREE, Math.ceil((systems.length - 1) * HUB_DEGREE_SHARE));
  const hubs = metrics
    .filter((m) => m.fanIn + m.fanOut >= hubThreshold)
    .map((m) => ({ id: m.id, name: m.name, degree: m.fanIn + m.fanOut }));

  // "Disconnected" only means something in a graph that has connections —
  // a one-system workspace has nothing to be disconnected *from*.
  const orphans =
    links.length === 0
      ? []
      : metrics
          .filter((m) => m.fanIn + m.fanOut === 0)
          .map((m) => byId.get(m.id)!)
          .filter((s) => s.role !== "entry")
          .map((s) => ({ id: s.id, name: s.name, fileCount: s.fileCount }))
          .sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name));

  return {
    cycles,
    violations,
    hubs,
    orphans,
    metrics,
    total: cycles.length + violations.length,
  };
}

/* ------------------------------------------------------------------ */
/* Ref diff — what a change does to the architecture                   */
/* ------------------------------------------------------------------ */

export interface SystemChange {
  id: string;
  name: string;
  role: SystemRole;
  fileCount: number;
}

export interface SystemResize {
  id: string;
  name: string;
  before: number;
  after: number;
}

export interface LinkChange {
  source: string;
  sourceName: string;
  target: string;
  targetName: string;
  weight: number;
  symbols: string[];
}

export interface LinkReweight extends Omit<LinkChange, "weight"> {
  before: number;
  after: number;
}

export interface ExternalChange {
  system: string;
  systemName: string;
  /** Service display name ("Stripe"). */
  name: string;
}

export interface SystemOverviewDiff {
  addedSystems: SystemChange[];
  removedSystems: SystemChange[];
  /** Systems whose file count moved by ≥ `RESIZE_MIN_DELTA` files. */
  resized: SystemResize[];
  addedLinks: LinkChange[];
  removedLinks: LinkChange[];
  /** Links whose weight moved by ≥ `REWEIGHT_MIN_DELTA` and ≥ 30%. */
  reweighted: LinkReweight[];
  addedExternals: ExternalChange[];
  removedExternals: ExternalChange[];
  /** Structural change count (everything except resizes/reweights). */
  total: number;
}

const RESIZE_MIN_DELTA = 3;
const REWEIGHT_MIN_DELTA = 3;
const REWEIGHT_MIN_RATIO = 0.3;

const linkKey = (l: SystemLink): string => `${l.source}->${l.target}`;

/**
 * Diff two overviews (base = a git ref, head = the working tree). Systems
 * match by id — ids derive from concept/name slugs, so a system keeps its
 * identity across refs as long as its cluster does.
 */
export function diffSystemOverviews(
  base: SystemOverview,
  head: SystemOverview,
): SystemOverviewDiff {
  const baseById = new Map(base.systems.map((s) => [s.id, s]));
  const headById = new Map(head.systems.map((s) => [s.id, s]));
  const change = (s: SystemModule): SystemChange => ({
    id: s.id,
    name: s.name,
    role: s.role,
    fileCount: s.fileCount,
  });

  const addedSystems = head.systems.filter((s) => !baseById.has(s.id)).map(change);
  const removedSystems = base.systems.filter((s) => !headById.has(s.id)).map(change);
  const resized: SystemResize[] = head.systems
    .filter((s) => {
      const before = baseById.get(s.id);
      return before && Math.abs(before.fileCount - s.fileCount) >= RESIZE_MIN_DELTA;
    })
    .map((s) => ({
      id: s.id,
      name: s.name,
      before: baseById.get(s.id)!.fileCount,
      after: s.fileCount,
    }))
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));

  const nameOf = (id: string): string => headById.get(id)?.name ?? baseById.get(id)?.name ?? id;
  const asLinkChange = (l: SystemLink): LinkChange => ({
    source: l.source,
    sourceName: nameOf(l.source),
    target: l.target,
    targetName: nameOf(l.target),
    weight: l.weight,
    symbols: l.symbols,
  });

  const baseLinks = new Map(base.links.map((l) => [linkKey(l), l]));
  const headLinks = new Map(head.links.map((l) => [linkKey(l), l]));
  const addedLinks = head.links.filter((l) => !baseLinks.has(linkKey(l))).map(asLinkChange);
  const removedLinks = base.links.filter((l) => !headLinks.has(linkKey(l))).map(asLinkChange);
  const reweighted: LinkReweight[] = head.links
    .filter((l) => {
      const before = baseLinks.get(linkKey(l));
      if (!before) return false;
      const delta = Math.abs(before.weight - l.weight);
      return delta >= REWEIGHT_MIN_DELTA && delta / Math.max(1, before.weight) >= REWEIGHT_MIN_RATIO;
    })
    .map((l) => {
      const { weight: _weight, ...rest } = asLinkChange(l);
      return { ...rest, before: baseLinks.get(linkKey(l))!.weight, after: l.weight };
    })
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));

  const addedExternals: ExternalChange[] = [];
  const removedExternals: ExternalChange[] = [];
  for (const s of head.systems) {
    const before = new Set((baseById.get(s.id)?.externals ?? []).map((x) => x.id));
    for (const x of s.externals) {
      if (!before.has(x.id)) addedExternals.push({ system: s.id, systemName: s.name, name: x.name });
    }
  }
  for (const s of base.systems) {
    const after = new Set((headById.get(s.id)?.externals ?? []).map((x) => x.id));
    for (const x of s.externals) {
      if (!after.has(x.id)) removedExternals.push({ system: s.id, systemName: s.name, name: x.name });
    }
  }

  return {
    addedSystems,
    removedSystems,
    resized,
    addedLinks,
    removedLinks,
    reweighted,
    addedExternals,
    removedExternals,
    total:
      addedSystems.length +
      removedSystems.length +
      addedLinks.length +
      removedLinks.length +
      addedExternals.length +
      removedExternals.length,
  };
}
