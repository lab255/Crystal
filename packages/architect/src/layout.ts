import dagre from "@dagrejs/dagre";
import {
  descendantsOf,
  isContainerKind,
  layerOfNode,
  type ArchLayer,
  type ArchNode,
  type ArchitectureGraph,
} from "@crystal/core";

const LEAF_W = 200;
const LEAF_H = 84;
const PADDING_X = 24;
const PADDING_Y = 48; // room for container headers
const BAND_GAP = 72;

/** Band order for `layers` mode; `null` = unlayered (containers, notes). */
const LAYER_ORDER: readonly (ArchLayer | null)[] = ["entry", "service", "data", null];

export interface AutoLayoutOptions {
  /**
   * "flow" (default): one top-to-bottom dagre pass per scope.
   * "layers": traffic flows top-down — entry/service/data bands stacked
   * vertically, dagre ordering nodes left-to-right within each band.
   */
  mode?: "flow" | "layers";
}

/**
 * Auto-layout, scope by scope: siblings under the same parent are laid out
 * using only the edges that stay inside that scope. Container sizes are
 * preserved; children of containers are positioned parent-relative.
 */
export function autoLayout(
  graph: ArchitectureGraph,
  opts: AutoLayoutOptions = {},
): ArchitectureGraph {
  const mode = opts.mode ?? "flow";
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
    if (mode === "layers") layoutScopeLayers(graph, ids, dims, positions, parent != null);
    else layoutScopeFlow(graph, ids, dims, positions, parent != null);
  }

  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const pos = positions.get(n.id);
      return pos ? { ...n, position: pos } : n;
    }),
  };
}

/**
 * Lay out only the children of one container (parent-relative), leaving every
 * other node untouched — used when a node is expanded in place.
 */
export function layoutChildrenOf(graph: ArchitectureGraph, parentId: string): ArchitectureGraph {
  const ids = graph.nodes.filter((n) => n.parentId === parentId).map((n) => n.id);
  if (ids.length === 0) return graph;
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
  layoutScopeFlow(graph, ids, dims, positions, true);
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const pos = positions.get(n.id);
      return pos ? { ...n, position: pos } : n;
    }),
  };
}

/**
 * Fit containers to their (parent-relative) children extents. Pass `onlyId`
 * to resize a single container.
 */
export function fitContainersToChildren(
  graph: ArchitectureGraph,
  onlyId?: string,
): ArchitectureGraph {
  const childrenOf = new Map<string, ArchNode[]>();
  for (const n of graph.nodes) {
    if (!n.parentId) continue;
    const list = childrenOf.get(n.parentId) ?? [];
    list.push(n);
    childrenOf.set(n.parentId, list);
  }
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (onlyId && n.id !== onlyId) return n;
      const children = childrenOf.get(n.id);
      if (!children || children.length === 0) return n;
      let maxX = 0;
      let maxY = 0;
      for (const c of children) {
        maxX = Math.max(maxX, c.position.x + (c.size?.width ?? LEAF_W));
        maxY = Math.max(maxY, c.position.y + (c.size?.height ?? LEAF_H));
      }
      return { ...n, size: { width: maxX + PADDING_X, height: maxY + PADDING_Y / 2 } };
    }),
  };
}

/**
 * Band a container by the majority layer of its (leaf) descendants, so a
 * "data" group of stores sinks to the data band even though `group` itself
 * has no derived layer.
 */
export function scopeLayerOf(graph: ArchitectureGraph, node: ArchNode): ArchLayer | null {
  if (!isContainerKind(node.kind)) return layerOfNode(node);
  if (node.layer) return node.layer;
  const counts = new Map<ArchLayer, number>();
  for (const d of descendantsOf(graph, node.id)) {
    if (isContainerKind(d.kind)) continue;
    const layer = layerOfNode(d);
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

function dagrePass(
  graph: ArchitectureGraph,
  ids: string[],
  dims: Map<string, { width: number; height: number }>,
  edgeScope: Set<string>,
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 48, ranksep: 72, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of ids) {
    const d = dims.get(id)!;
    g.setNode(id, { width: d.width, height: d.height });
  }
  for (const e of graph.edges) {
    if (edgeScope.has(e.source) && edgeScope.has(e.target) && e.source !== e.target) {
      g.setEdge(e.source, e.target);
    }
  }
  dagre.layout(g);
  const out = new Map<string, { x: number; y: number }>();
  for (const id of ids) {
    const pos = g.node(id);
    const d = dims.get(id)!;
    out.set(id, { x: pos.x - d.width / 2, y: pos.y - d.height / 2 });
  }
  return out;
}

function layoutScopeFlow(
  graph: ArchitectureGraph,
  ids: string[],
  dims: Map<string, { width: number; height: number }>,
  positions: Map<string, { x: number; y: number }>,
  nested: boolean,
): void {
  const scope = new Set(ids);
  for (const [id, pos] of dagrePass(graph, ids, dims, scope)) {
    positions.set(id, {
      x: pos.x + (nested ? PADDING_X : 0),
      y: pos.y + (nested ? PADDING_Y : 0),
    });
  }
}

function layoutScopeLayers(
  graph: ArchitectureGraph,
  ids: string[],
  dims: Map<string, { width: number; height: number }>,
  positions: Map<string, { x: number; y: number }>,
  nested: boolean,
): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const bands = LAYER_ORDER.map((layer) => ({ layer, ids: [] as string[] }));
  for (const id of ids) {
    const layer = scopeLayerOf(graph, byId.get(id)!);
    bands[LAYER_ORDER.indexOf(layer)]!.ids.push(id);
  }

  interface LaidBand {
    nodes: { id: string; x: number; y: number }[];
    width: number;
    height: number;
  }
  const BAND_MAX_W = 1200;
  const GAP_X = 36;
  const GAP_Y = 36;
  const laid: LaidBand[] = [];
  for (const band of bands) {
    if (band.ids.length === 0) continue;
    // A dagre pass over intra-band edges yields the left-to-right ordering;
    // members are then placed in wrapped horizontal rows (dagre alone would
    // stack disconnected siblings vertically).
    const pass = dagrePass(graph, band.ids, dims, new Set(band.ids));
    const ordered = [...pass.entries()]
      .sort((a, b) => a[1].x - b[1].x || a[1].y - b[1].y)
      .map(([id]) => id);
    const nodes: LaidBand["nodes"] = [];
    let x = 0;
    let rowY = 0;
    let rowH = 0;
    let width = 0;
    for (const id of ordered) {
      const d = dims.get(id)!;
      if (x > 0 && x + d.width > BAND_MAX_W) {
        rowY += rowH + GAP_Y;
        x = 0;
        rowH = 0;
      }
      nodes.push({ id, x, y: rowY });
      width = Math.max(width, x + d.width);
      rowH = Math.max(rowH, d.height);
      x += d.width + GAP_X;
    }
    laid.push({ nodes, width, height: rowY + rowH });
  }

  const maxWidth = Math.max(0, ...laid.map((b) => b.width));
  const x0 = nested ? PADDING_X : 0;
  let y = nested ? PADDING_Y : 0;
  for (const band of laid) {
    const center = (maxWidth - band.width) / 2;
    for (const n of band.nodes) positions.set(n.id, { x: x0 + center + n.x, y: y + n.y });
    y += band.height + BAND_GAP;
  }
}
