import { isContainerKind, type ArchEdge, type ArchNode, type ArchitectureGraph } from "@crystal/core";

/**
 * Infrastructure view model — for one environment, group the architecture's
 * components by the deployment target they are placed on (a service-map
 * "where does this actually run" projection of the same graph). Placements
 * live on the nodes themselves (`node.placements[envId]`), so drafts and
 * rebases cover them for free.
 */

export interface InfraGroup {
  target: string;
  nodes: ArchNode[];
}

/** Components eligible for placement — containers and notes are logical-only. */
export function placeableNodes(graph: ArchitectureGraph): ArchNode[] {
  return graph.nodes.filter((n) => !isContainerKind(n.kind) && n.kind !== "note");
}

export function infraGroups(
  graph: ArchitectureGraph,
  envId: string,
): { groups: InfraGroup[]; unplaced: ArchNode[] } {
  const byTarget = new Map<string, ArchNode[]>();
  const unplaced: ArchNode[] = [];
  for (const node of placeableNodes(graph)) {
    const target = node.placements[envId]?.target.trim();
    if (!target) {
      unplaced.push(node);
      continue;
    }
    byTarget.set(target, [...(byTarget.get(target) ?? []), node]);
  }
  const groups = [...byTarget.entries()]
    .map(([target, nodes]) => ({ target, nodes }))
    .sort((a, b) => a.target.localeCompare(b.target));
  return { groups, unplaced };
}

/** Edges whose endpoints are both placed in the environment. */
export function placedEdges(graph: ArchitectureGraph, envId: string): ArchEdge[] {
  const placed = new Set(
    placeableNodes(graph)
      .filter((n) => n.placements[envId]?.target.trim())
      .map((n) => n.id),
  );
  return graph.edges.filter((e) => placed.has(e.source) && placed.has(e.target));
}

/** Every target used across all environments — suggestions for placement. */
export function knownTargets(graph: ArchitectureGraph): string[] {
  const targets = new Set<string>();
  for (const node of graph.nodes) {
    for (const placement of Object.values(node.placements)) {
      const t = placement.target.trim();
      if (t) targets.add(t);
    }
  }
  return [...targets].sort();
}
