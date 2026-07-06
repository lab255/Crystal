import type {
  ArchNode,
  ArchitectureGraph,
  CodeMapSummary,
  CodeModule,
} from "@crystal/core";

/**
 * Code overlay — reconciles a hand-drawn architecture diagram with the code
 * map derived from source. Nodes link to code modules (explicitly via
 * `codeModule`, or auto-matched by name); with the links in place, every
 * module-level import edge either corroborates a drawn edge (confirmed),
 * contradicts its absence (ghost: in the code, not in the diagram), or is
 * absent where an edge was drawn (stale: in the diagram, not in the code).
 */

export interface OverlayBadge {
  module: string;
  fileCount: number;
  /** True when the link is a name match, not a persisted `codeModule`. */
  auto: boolean;
}

/** A module dependency present in code but missing from the diagram. */
export interface OverlayGhostEdge {
  /** Arch node ids. */
  source: string;
  target: string;
  weight: number;
  sourceModule: string;
  targetModule: string;
}

export interface OverlayResult {
  /** Arch node id → linked module info. */
  nodeBadges: Map<string, OverlayBadge>;
  /** Diagram edge ids whose endpoints' modules import each other in code. */
  confirmedEdgeIds: Set<string>;
  /** Diagram edge ids between linked nodes with no code dependency. */
  staleEdgeIds: Set<string>;
  ghostEdges: OverlayGhostEdge[];
  /** Modules with files that no diagram node is linked to. */
  unmappedModules: CodeModule[];
}

/** Loose name key: case/punctuation-insensitive, npm scope stripped. */
function nameKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Best module for an unlinked node, by name: module display name first, then
 * path basename. Returns null when nothing matches.
 */
export function suggestModuleFor(node: ArchNode, modules: CodeModule[]): CodeModule | null {
  const key = nameKey(node.label);
  if (!key) return null;
  return (
    modules.find((m) => nameKey(m.name) === key) ??
    modules.find((m) => nameKey(m.path.split("/").pop() ?? m.path) === key) ??
    null
  );
}

/**
 * Link diagram nodes to code modules — explicit `codeModule` wins, then name
 * matches; each module auto-links to at most one node. Shared by the code
 * overlay and the dataflow projection.
 */
export function linkNodesToModules(
  graph: ArchitectureGraph,
  summary: CodeMapSummary,
): Map<string, OverlayBadge> {
  const modulesByPath = new Map(summary.modules.map((m) => [m.path, m]));
  const nodeBadges = new Map<string, OverlayBadge>();
  const takenModules = new Set<string>();
  const linkable = graph.nodes.filter((n) => n.kind !== "note");

  for (const node of linkable) {
    const module = node.codeModule ? modulesByPath.get(node.codeModule) : undefined;
    if (module) {
      nodeBadges.set(node.id, { module: module.path, fileCount: module.fileCount, auto: false });
      takenModules.add(module.path);
    }
  }
  for (const node of linkable) {
    if (nodeBadges.has(node.id)) continue;
    const candidates = summary.modules.filter((m) => !takenModules.has(m.path));
    const match = suggestModuleFor(node, candidates);
    if (match) {
      nodeBadges.set(node.id, { module: match.path, fileCount: match.fileCount, auto: true });
      takenModules.add(match.path);
    }
  }
  return nodeBadges;
}

export function computeOverlay(
  graph: ArchitectureGraph,
  summary: CodeMapSummary,
): OverlayResult {
  // 1. Link nodes to modules.
  const nodeBadges = linkNodesToModules(graph, summary);
  const takenModules = new Set([...nodeBadges.values()].map((b) => b.module));
  const linkable = graph.nodes.filter((n) => n.kind !== "note");

  // Module → representative node (first linked node wins for edge overlay).
  const moduleToNode = new Map<string, string>();
  for (const node of linkable) {
    const badge = nodeBadges.get(node.id);
    if (badge && !moduleToNode.has(badge.module)) moduleToNode.set(badge.module, node.id);
  }

  // 2. Compare code deps against drawn edges, direction-insensitively —
  //    diagrams draw "A talks to B" with either arrowhead.
  const codePairs = new Map<string, number>(); // "modA|modB" both orders → weight
  for (const dep of summary.deps) {
    codePairs.set(`${dep.source}|${dep.target}`, dep.weight);
  }
  const hasCodeDep = (a: string, b: string) => codePairs.has(`${a}|${b}`) || codePairs.has(`${b}|${a}`);

  const confirmedEdgeIds = new Set<string>();
  const staleEdgeIds = new Set<string>();
  const drawnPairs = new Set<string>(); // "nodeA|nodeB" both orders
  for (const edge of graph.edges) {
    const sourceBadge = nodeBadges.get(edge.source);
    const targetBadge = nodeBadges.get(edge.target);
    drawnPairs.add(`${edge.source}|${edge.target}`);
    drawnPairs.add(`${edge.target}|${edge.source}`);
    if (!sourceBadge || !targetBadge || sourceBadge.module === targetBadge.module) continue;
    if (hasCodeDep(sourceBadge.module, targetBadge.module)) confirmedEdgeIds.add(edge.id);
    else staleEdgeIds.add(edge.id);
  }

  // 3. Code deps with linked endpoints but no drawn edge → ghosts.
  const ghostEdges: OverlayGhostEdge[] = [];
  for (const dep of summary.deps) {
    const source = moduleToNode.get(dep.source);
    const target = moduleToNode.get(dep.target);
    if (!source || !target || source === target) continue;
    if (drawnPairs.has(`${source}|${target}`)) continue;
    ghostEdges.push({
      source,
      target,
      weight: dep.weight,
      sourceModule: dep.source,
      targetModule: dep.target,
    });
  }

  const unmappedModules = summary.modules.filter(
    (m) => m.fileCount > 0 && !takenModules.has(m.path),
  );

  return { nodeBadges, confirmedEdgeIds, staleEdgeIds, ghostEdges, unmappedModules };
}

/** Persist current auto-matches as explicit `codeModule` links. */
export function adoptAutoLinks(graph: ArchitectureGraph, overlay: OverlayResult): ArchitectureGraph {
  const nodes = graph.nodes.map((n) => {
    const badge = overlay.nodeBadges.get(n.id);
    return badge?.auto ? { ...n, codeModule: badge.module } : n;
  });
  return { ...graph, nodes };
}
