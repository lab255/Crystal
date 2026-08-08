import {
  ARCH_LAYERS,
  isContainerKind,
  layerOfNode,
  type ArchEdge,
  type ArchLayer,
  type ArchNode,
  type ArchNodeKind,
  type ArchitectureGraph,
} from "@crystal/core";

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

export const INFRA_ZONE_KINDS = [
  "vpc",
  "subnet",
  "securitygroup",
] as const satisfies readonly ArchNodeKind[];
export type InfraZoneKind = (typeof INFRA_ZONE_KINDS)[number];

export function canNestZone(child: InfraZoneKind, parent: InfraZoneKind): boolean {
  return child === "subnet"
    ? parent === "vpc"
    : child === "securitygroup"
      ? parent === "vpc" || parent === "subnet"
      : false;
}

export function zoneNestingRejection(
  child: InfraZoneKind,
  parent: InfraZoneKind,
): string | null {
  if (canNestZone(child, parent)) return null;
  const label = (kind: InfraZoneKind) =>
    kind === "vpc" ? "VPC" : kind === "subnet" ? "subnet" : "security group";
  return `A ${label(child)} can't nest inside a ${label(parent)}`;
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
