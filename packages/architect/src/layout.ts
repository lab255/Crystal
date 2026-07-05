import dagre from "@dagrejs/dagre";
import { isContainerKind, type ArchitectureGraph } from "@crystal/core";

const LEAF_W = 200;
const LEAF_H = 84;
const PADDING_X = 24;
const PADDING_Y = 48; // room for container headers

/**
 * Auto-layout with dagre, scope by scope: siblings under the same parent are
 * laid out left-to-right using only the edges that stay inside that scope.
 * Container sizes are preserved.
 */
export function autoLayout(graph: ArchitectureGraph): ArchitectureGraph {
  const nodesByParent = new Map<string | null, string[]>();
  for (const n of graph.nodes) {
    const key = n.parentId ?? null;
    const list = nodesByParent.get(key) ?? [];
    list.push(n.id);
    nodesByParent.set(key, list);
  }

  const dims = new Map<string, { width: number; height: number }>();
  for (const n of graph.nodes) {
    dims.set(
      n.id,
      isContainerKind(n.kind)
        ? { width: n.size?.width ?? 420, height: n.size?.height ?? 280 }
        : { width: LEAF_W, height: LEAF_H },
    );
  }

  const positions = new Map<string, { x: number; y: number }>();

  for (const [parent, ids] of nodesByParent) {
    const scope = new Set(ids);
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 36, ranksep: 90, marginx: 16, marginy: 16 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const id of ids) {
      const d = dims.get(id)!;
      g.setNode(id, { width: d.width, height: d.height });
    }
    for (const e of graph.edges) {
      if (scope.has(e.source) && scope.has(e.target) && e.source !== e.target) {
        g.setEdge(e.source, e.target);
      }
    }
    dagre.layout(g);
    for (const id of ids) {
      const pos = g.node(id);
      const d = dims.get(id)!;
      positions.set(id, {
        x: pos.x - d.width / 2 + (parent ? PADDING_X : 0),
        y: pos.y - d.height / 2 + (parent ? PADDING_Y : 0),
      });
    }
  }

  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const pos = positions.get(n.id);
      return pos ? { ...n, position: pos } : n;
    }),
  };
}
