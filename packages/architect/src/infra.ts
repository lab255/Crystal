import {
  ARCH_LAYERS,
  isContainerKind,
  layerOfNode,
  type ArchEdge,
  type ArchDeployTarget,
  type ArchLayer,
  type ArchNode,
  type ArchitectureGraph,
} from "@crystal/core";

export { INFRA_ZONE_KINDS, canNestZone, zoneNestingRejection } from "@crystal/core";
export type { InfraZoneKind } from "@crystal/core";

/**
 * Infrastructure view model — for one environment, group the architecture's
 * components by the deployment target they are placed on (a service-map
 * "where does this actually run" projection of the same graph). Placements
 * live on the nodes themselves (`node.placements[envId]`), so drafts and
 * rebases cover them for free.
 */

export interface InfraGroup {
  target: ArchDeployTarget;
  nodes: ArchNode[];
}

export function environmentPlacementCount(graph: ArchitectureGraph, envId: string): number {
  return graph.nodes.filter((node) => envId in node.placements).length;
}

/** Components eligible for placement — containers and notes are logical-only. */
export function placeableNodes(graph: ArchitectureGraph): ArchNode[] {
  return graph.nodes.filter((n) => !isContainerKind(n.kind) && n.kind !== "note");
}

export function infraGroups(
  graph: ArchitectureGraph,
  envId: string,
): { groups: InfraGroup[]; unplaced: ArchNode[] } {
  const environment = graph.environments.find((candidate) => candidate.id === envId);
  const targets = new Map((environment?.targets ?? []).map((target) => [target.id, target]));
  const byTarget = new Map<string, { target: ArchDeployTarget; nodes: ArchNode[] }>();
  const unplaced: ArchNode[] = [];
  for (const node of placeableNodes(graph)) {
    const placement = node.placements[envId];
    if (!placement?.targetId) {
      unplaced.push(node);
      continue;
    }
    const target = targets.get(placement.targetId) ?? {
      id: placement.targetId,
      name: placement.target || "Unknown target",
      kind: "other" as const,
    };
    const group = byTarget.get(target.id) ?? { target, nodes: [] };
    group.nodes.push(node);
    byTarget.set(target.id, group);
  }
  const groups = [...byTarget.values()].sort((a, b) => a.target.id.localeCompare(b.target.id));
  return { groups, unplaced };
}

/** Edges whose endpoints are both placed in the environment. */
export function placedEdges(graph: ArchitectureGraph, envId: string): ArchEdge[] {
  const placed = new Set(
    placeableNodes(graph)
      .filter((n) => n.placements[envId]?.targetId)
      .map((n) => n.id),
  );
  return graph.edges.filter((e) => placed.has(e.source) && placed.has(e.target));
}

export interface InfraTargetEdge {
  id: string;
  source: string;
  target: string;
}

/** Aggregate component dependencies to stable target-pair edges for layout only. */
export function infraTargetEdges(graph: ArchitectureGraph, envId: string): InfraTargetEdge[] {
  const targetOf = new Map(
    placeableNodes(graph).flatMap((node) => {
      const targetId = node.placements[envId]?.targetId;
      return targetId ? [[node.id, targetId] as const] : [];
    }),
  );
  const pairs = new Map<string, InfraTargetEdge>();
  for (const edge of placedEdges(graph, envId)) {
    const source = targetOf.get(edge.source);
    const target = targetOf.get(edge.target);
    if (!source || !target || source === target) continue;
    const id = `${source}->${target}`;
    if (!pairs.has(id)) pairs.set(id, { id, source, target });
  }
  return [...pairs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Exact induced graph simulated by the deployment view for one environment. */
export function environmentSubgraph(graph: ArchitectureGraph, envId: string): ArchitectureGraph {
  const nodes = placeableNodes(graph).filter((node) => node.placements[envId]?.targetId);
  const ids = new Set(nodes.map((node) => node.id));
  return { ...graph, nodes, edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) };
}

/** Majority layer of a target group's members (ties break toward the first counted). */
export function groupLayer(group: InfraGroup): ArchLayer | null {
  const counts = new Map<ArchLayer, number>();
  for (const node of group.nodes) {
    const layer = layerOfNode(node);
    if (layer) counts.set(layer, (counts.get(layer) ?? 0) + 1);
  }
  let best: ArchLayer | null = null;
  let bestCount = 0;
  for (const [layer, count] of counts) {
    if (count > bestCount) {
      best = layer;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Target groups stacked into top-down traffic bands (entry → service → data,
 * unlayered last) — the same reading order as the diagram's layered layout.
 */
export function layerBands(
  groups: InfraGroup[],
): { layer: ArchLayer | null; groups: InfraGroup[] }[] {
  const order: (ArchLayer | null)[] = [...ARCH_LAYERS, null];
  return order
    .map((layer) => ({ layer, groups: groups.filter((g) => groupLayer(g) === layer) }))
    .filter((band) => band.groups.length > 0);
}

/** Every target used across all environments — suggestions for placement. */
export function knownTargets(graph: ArchitectureGraph): ArchDeployTarget[] {
  const targets = new Map<string, ArchDeployTarget>();
  for (const environment of graph.environments) {
    for (const target of environment.targets ?? []) targets.set(target.id, target);
  }
  return [...targets.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Aspect-aware grid width for target members; no fixed column ceiling. */
export function targetMemberColumns(
  count: number,
  viewportAspect: number,
  cell: { width: number; height: number },
): number {
  if (count <= 1) return 1;
  const aspect = Math.max(0.75, viewportAspect);
  return Math.max(1, Math.min(count, Math.round(Math.sqrt(count * aspect * (cell.height / cell.width)))));
}
