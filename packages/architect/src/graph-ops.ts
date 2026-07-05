import {
  createArchNode,
  descendantsOf,
  uid,
  wouldCreateCycle,
  type ArchEdge,
  type ArchEdgeKind,
  type ArchNode,
  type ArchNodeKind,
  type ArchitectureGraph,
} from "@crystal/core";

/** Absolute (canvas-space) position of a node, resolving nested parents. */
export function absolutePosition(
  graph: ArchitectureGraph,
  nodeId: string,
): { x: number; y: number } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let cur = byId.get(nodeId);
  let x = 0;
  let y = 0;
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    x += cur.position.x;
    y += cur.position.y;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return { x, y };
}

export function nestingDepth(graph: ArchitectureGraph, nodeId: string): number {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let depth = 0;
  let cur = byId.get(nodeId);
  const guard = new Set<string>();
  while (cur?.parentId && !guard.has(cur.id)) {
    guard.add(cur.id);
    depth++;
    cur = byId.get(cur.parentId);
  }
  return depth;
}

export function addNode(
  graph: ArchitectureGraph,
  kind: ArchNodeKind,
  label: string,
  position: { x: number; y: number },
  parentId?: string | null,
): { graph: ArchitectureGraph; node: ArchNode } {
  const node = createArchNode(kind, label, position, parentId);
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, node };
}

export function updateNode(
  graph: ArchitectureGraph,
  id: string,
  patch: Partial<ArchNode>,
): ArchitectureGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === id ? { ...n, ...patch, id: n.id } : n)),
  };
}

/** Delete nodes, their descendants and every touching edge. */
export function deleteNodes(graph: ArchitectureGraph, ids: string[]): ArchitectureGraph {
  const doomed = new Set(ids);
  for (const id of ids) {
    for (const child of descendantsOf(graph, id)) doomed.add(child.id);
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => !doomed.has(n.id)),
    edges: graph.edges.filter((e) => !doomed.has(e.source) && !doomed.has(e.target)),
  };
}

/**
 * Reparent a node (or detach it with `parentId: null`), keeping it at the
 * given absolute canvas position. Rejects cycles by returning the graph
 * unchanged.
 */
export function reparentNode(
  graph: ArchitectureGraph,
  nodeId: string,
  parentId: string | null,
  absPos: { x: number; y: number },
): ArchitectureGraph {
  if (parentId && wouldCreateCycle(graph, nodeId, parentId)) return graph;
  const parentAbs = parentId ? absolutePosition(graph, parentId) : { x: 0, y: 0 };
  return updateNode(graph, nodeId, {
    parentId,
    position: { x: absPos.x - parentAbs.x, y: absPos.y - parentAbs.y },
  });
}

export function addEdge(
  graph: ArchitectureGraph,
  source: string,
  target: string,
  kind: ArchEdgeKind,
): ArchitectureGraph {
  if (source === target) return graph;
  const exists = graph.edges.some((e) => e.source === source && e.target === target);
  if (exists) return graph;
  const edge: ArchEdge = { id: uid("edge"), source, target, kind, label: "" };
  return { ...graph, edges: [...graph.edges, edge] };
}

export function updateEdge(
  graph: ArchitectureGraph,
  id: string,
  patch: Partial<ArchEdge>,
): ArchitectureGraph {
  return {
    ...graph,
    edges: graph.edges.map((e) => (e.id === id ? { ...e, ...patch, id: e.id } : e)),
  };
}

export function deleteEdges(graph: ArchitectureGraph, ids: string[]): ArchitectureGraph {
  const doomed = new Set(ids);
  return { ...graph, edges: graph.edges.filter((e) => !doomed.has(e.id)) };
}

/** Deepest container whose absolute rect contains the point, excluding a node and its subtree. */
export function containerAtPoint(
  graph: ArchitectureGraph,
  point: { x: number; y: number },
  excludeNodeId?: string,
): ArchNode | null {
  const excluded = new Set<string>();
  if (excludeNodeId) {
    excluded.add(excludeNodeId);
    for (const d of descendantsOf(graph, excludeNodeId)) excluded.add(d.id);
  }
  let best: ArchNode | null = null;
  let bestDepth = -1;
  for (const n of graph.nodes) {
    if (excluded.has(n.id)) continue;
    if (n.kind !== "system" && n.kind !== "group") continue;
    const abs = absolutePosition(graph, n.id);
    const w = n.size?.width ?? 420;
    const h = n.size?.height ?? 280;
    if (point.x < abs.x || point.y < abs.y || point.x > abs.x + w || point.y > abs.y + h) continue;
    const depth = nestingDepth(graph, n.id);
    if (depth > bestDepth) {
      best = n;
      bestDepth = depth;
    }
  }
  return best;
}
