import { isInfraZone, type ArchEdge, type ArchNode, type ArchitectureGraph } from "@crystal/core";

export interface InfraOnlyProjection {
  nodes: ArchNode[];
  edges: ArchEdge[];
}

/**
 * Remove deployment-only topology from an architecture projection. Descendants
 * are included defensively: a malformed logical node must not escape its zone
 * merely because its own kind is not an infra-zone kind.
 */
export function splitInfraOnly(graph: ArchitectureGraph): {
  view: ArchitectureGraph;
  infraOnly: InfraOnlyProjection;
} {
  const infraIds = new Set(graph.nodes.filter((node) => isInfraZone(node.kind)).map((node) => node.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (node.parentId && infraIds.has(node.parentId) && !infraIds.has(node.id)) {
        infraIds.add(node.id);
        changed = true;
      }
    }
  }
  const infraOnly = {
    nodes: graph.nodes.filter((node) => infraIds.has(node.id)),
    edges: graph.edges.filter((edge) => infraIds.has(edge.source) || infraIds.has(edge.target)),
  };
  return {
    infraOnly,
    view: {
      ...graph,
      nodes: graph.nodes.filter((node) => !infraIds.has(node.id)),
      edges: graph.edges.filter((edge) => !infraIds.has(edge.source) && !infraIds.has(edge.target)),
    },
  };
}

/** Reattach deployment-only nodes after an architecture edit before extraction. */
export function reinjectInfraOnly(edited: ArchitectureGraph, infraOnly: InfraOnlyProjection): ArchitectureGraph {
  const infraIds = new Set(infraOnly.nodes.map((node) => node.id));
  const infraEdgeIds = new Set(infraOnly.edges.map((edge) => edge.id));
  return {
    ...edited,
    nodes: [...edited.nodes.filter((node) => !infraIds.has(node.id)), ...infraOnly.nodes],
    edges: [...edited.edges.filter((edge) => !infraEdgeIds.has(edge.id)), ...infraOnly.edges],
  };
}
