import {
  isContainerKind,
  type ArchNode,
  type ArchitectureGraph,
  type CodeExternalDep,
  type CodeMapSummary,
} from "@crystal/core";

/**
 * Detected dependencies for the infrastructure service map — edges the code
 * itself proves, layered over whatever the user has drawn:
 *
 *   internal  module → module import edges (from the live code map) between
 *             placed components, for pairs the diagram doesn't already connect
 *   external  services implied by npm imports (databases, caches, queues,
 *             SaaS APIs…), attached to the placed components that import them
 *
 * Everything here is a pure projection of (graph, environment, summary) —
 * nothing is persisted; the overlay follows the code as it changes.
 */

/** Synthetic react-flow node id for a detected external service. */
export function externalNodeId(dep: CodeExternalDep): string {
  return `ext:${dep.id}`;
}

/** Placed, module-linked components keyed by their code module path. */
function placedByModule(graph: ArchitectureGraph, envId: string): Map<string, ArchNode> {
  const byModule = new Map<string, ArchNode>();
  for (const node of graph.nodes) {
    if (isContainerKind(node.kind) || node.kind === "note") continue;
    if (!node.codeModule) continue;
    if (!node.placements[envId]?.target.trim()) continue;
    byModule.set(node.codeModule, node);
  }
  return byModule;
}

export interface DetectedEdge {
  source: string;
  target: string;
  weight: number;
}

/**
 * Import edges between placed components that the diagram doesn't already
 * draw (any explicit edge between the pair, in that direction, suppresses the
 * detected one — the user's arrow wins).
 */
export function detectedInternalEdges(
  graph: ArchitectureGraph,
  envId: string,
  summary: CodeMapSummary,
): DetectedEdge[] {
  const byModule = placedByModule(graph, envId);
  const drawn = new Set(graph.edges.map((e) => `${e.source}->${e.target}`));
  const out: DetectedEdge[] = [];
  for (const dep of summary.deps) {
    const source = byModule.get(dep.source);
    const target = byModule.get(dep.target);
    if (!source || !target || source.id === target.id) continue;
    if (drawn.has(`${source.id}->${target.id}`)) continue;
    out.push({ source: source.id, target: target.id, weight: dep.weight });
  }
  return out;
}

export interface DetectedExternal {
  dep: CodeExternalDep;
  /** Placed components importing this service's client libraries. */
  clients: { nodeId: string; weight: number }[];
}

/**
 * Detected external services whose importing modules are placed in the
 * environment (services only imported by unplaced components stay out of the
 * map — the environment lens applies to them too).
 */
export function detectedExternals(
  graph: ArchitectureGraph,
  envId: string,
  summary: CodeMapSummary,
): DetectedExternal[] {
  const byModule = placedByModule(graph, envId);
  const out: DetectedExternal[] = [];
  for (const dep of summary.externals ?? []) {
    const clients: { nodeId: string; weight: number }[] = [];
    const seen = new Map<string, number>();
    for (const client of dep.clients) {
      const node = byModule.get(client.module);
      if (!node) continue;
      seen.set(node.id, (seen.get(node.id) ?? 0) + client.weight);
    }
    for (const [nodeId, weight] of seen) clients.push({ nodeId, weight });
    if (clients.length > 0) {
      clients.sort((a, b) => b.weight - a.weight);
      out.push({ dep, clients });
    }
  }
  return out;
}
