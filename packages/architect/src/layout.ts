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
const ROW_MAX_W = 1200;
const GAP_X = 36;
const GAP_Y = 36;

/** Band order for `layers` mode; `null` = unlayered (containers, notes). */
const LAYER_ORDER: readonly (ArchLayer | null)[] = ["entry", "service", "data", null];

/**
 * Fullstack columns for scopes mixing frontend and backend: UI on the left,
 * the API boundary (gateways, entry tier) next, then services, then data —
 * requests read left-to-right across the stack.
 */
type StackBand = "frontend" | "boundary" | "service" | "data";
const STACK_ORDER: readonly (StackBand | null)[] = ["frontend", "boundary", "service", "data", null];

export interface AutoLayoutOptions {
  /**
   * "flow" (default): top-to-bottom Dagre inside each connected component,
   * then compact wrapped-row packing of the component blocks per scope.
   * "layers": role-banded. Backend scopes stack entry/service/data bands
   * top-down; scopes mixing frontend and backend lay out as horizontal
   * fullstack columns (frontend → api boundary → services → data). Dagre
   * orders nodes within each band.
   */
  mode?: "flow" | "layers";
  /**
   * Pre-allocated footprints by node id: lay these nodes out at their future
   * expanded size (skeletal reservation), so zooming into code fills space
   * that already exists instead of colliding with neighbors.
   */
  reserve?: ReadonlyMap<string, { width: number; height: number }>;
}

/**
 * Auto-layout, scope by scope: siblings under the same parent are laid out
 * using only the edges that stay inside that scope. Container sizes are
 * preserved; children of containers are positioned parent-relative.
 * Callers rendering the architecture view must pass `splitInfraOnly(graph).view`;
 * deployment zones are intentionally outside this entry point's layout domain.
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
  for (const ids of nodesByParent.values()) ids.sort((a, b) => a.localeCompare(b));

  const dims = new Map<string, { width: number; height: number }>();
  for (const n of graph.nodes) {
    dims.set(
      n.id,
      opts.reserve?.get(n.id) ??
        (isContainerKind(n.kind)
          ? { width: n.size?.width ?? 420, height: n.size?.height ?? 280 }
          : { width: LEAF_W, height: LEAF_H }),
    );
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [parent, ids] of nodesByParent) {
    if (mode === "layers") {
      if (scopeIsFullstack(graph, ids)) layoutScopeStacks(graph, ids, dims, positions, parent != null);
      else layoutScopeLayers(graph, ids, dims, positions, parent != null);
    } else {
      layoutScopeFlow(graph, ids, dims, positions, parent != null);
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

/** Derived container ids the layout owns the size of (never user-sized). */
const FITTED_ID_PREFIXES = ["mod:", "screens:", "routes:", "ctr:", "c4:"];

/**
 * Auto-layout with derived containers (`mod:` module groups, `screens:`/
 * `routes:` groups, the C4 boundary and container scopes) fitted to their
 * children: layout → fit → layout again so sibling spacing in the outer
 * scope uses the fitted sizes, not the projection's placeholder (the C4
 * boundary is minted at 640×420 — five containers overflow it badly).
 * Child positions are scope-local and deterministic, so the second pass
 * reproduces them and the fitted sizes stay valid.
 */
export function autoLayoutFitted(
  graph: ArchitectureGraph,
  opts: AutoLayoutOptions = {},
): ArchitectureGraph {
  let laid = autoLayout(graph, opts);
  const hasChildren = new Set(laid.nodes.map((n) => n.parentId).filter(Boolean));
  const derivedContainers = laid.nodes
    .filter(
      (n) =>
        isContainerKind(n.kind) &&
        hasChildren.has(n.id) &&
        FITTED_ID_PREFIXES.some((p) => n.id.startsWith(p)),
    )
    .map((n) => n.id);
  if (derivedContainers.length === 0) return laid;
  for (const id of derivedContainers) laid = fitContainersToChildren(laid, id, opts.reserve);
  laid = autoLayout(laid, opts);
  for (const id of derivedContainers) laid = fitContainersToChildren(laid, id, opts.reserve);
  return laid;
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
 * to resize a single container, and `reserve` to measure children at their
 * pre-allocated LOD footprints instead of the plain leaf size.
 */
export function fitContainersToChildren(
  graph: ArchitectureGraph,
  onlyId?: string,
  reserve?: ReadonlyMap<string, { width: number; height: number }>,
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
        const d = reserve?.get(c.id);
        maxX = Math.max(maxX, c.position.x + (d?.width ?? c.size?.width ?? LEAF_W));
        maxY = Math.max(maxY, c.position.y + (d?.height ?? c.size?.height ?? LEAF_H));
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

/** Fullstack column of a leaf: kind first (frontends/gateways), then layer. */
function leafStackBand(node: ArchNode): StackBand | null {
  if (node.kind === "note") return null;
  if (node.kind === "frontend") return "frontend";
  if (node.kind === "gateway" || node.kind === "external") return "boundary";
  const layer = layerOfNode(node);
  if (layer === "entry") return "boundary";
  if (layer === "service") return "service";
  if (layer === "data") return "data";
  return null;
}

/** Fullstack column of a scope member; containers take their majority leaf column. */
function scopeStackBandOf(graph: ArchitectureGraph, node: ArchNode): StackBand | null {
  if (!isContainerKind(node.kind)) return leafStackBand(node);
  const counts = new Map<StackBand, number>();
  for (const d of descendantsOf(graph, node.id)) {
    if (isContainerKind(d.kind)) continue;
    const band = leafStackBand(d);
    if (band) counts.set(band, (counts.get(band) ?? 0) + 1);
  }
  let best: StackBand | null = null;
  let bestCount = 0;
  for (const [band, count] of counts) {
    if (count > bestCount) {
      best = band;
      bestCount = count;
    }
  }
  return best;
}

/**
 * A scope reads as fullstack when it holds frontend members alongside
 * backend ones — then the layered layout runs horizontally instead of
 * stacking request tiers top-down.
 */
export function scopeIsFullstack(graph: ArchitectureGraph, ids: readonly string[]): boolean {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const bands = new Set<StackBand | null>();
  for (const id of ids) {
    const node = byId.get(id);
    if (node) bands.add(scopeStackBandOf(graph, node));
  }
  return bands.has("frontend") && (bands.has("boundary") || bands.has("service") || bands.has("data"));
}

function dagrePass(
  graph: ArchitectureGraph,
  ids: string[],
  dims: Map<string, { width: number; height: number }>,
  edgeScope: Set<string>,
): Map<string, { x: number; y: number }> {
  const orderedIds = [...ids].sort((a, b) => a.localeCompare(b));
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 48, ranksep: 72, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of orderedIds) {
    const d = dims.get(id)!;
    g.setNode(id, { width: d.width, height: d.height });
  }
  const orderedEdges = [...graph.edges].sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.target.localeCompare(b.target) ||
      a.id.localeCompare(b.id),
  );
  for (const e of orderedEdges) {
    if (edgeScope.has(e.source) && edgeScope.has(e.target) && e.source !== e.target) {
      g.setEdge(e.source, e.target);
    }
  }
  dagre.layout(g);
  const out = new Map<string, { x: number; y: number }>();
  for (const id of orderedIds) {
    const pos = g.node(id);
    const d = dims.get(id)!;
    out.set(id, { x: pos.x - d.width / 2, y: pos.y - d.height / 2 });
  }
  return out;
}

interface RowItem<T> {
  item: T;
  width: number;
  height: number;
}

interface PackedRowItem<T> extends RowItem<T> {
  x: number;
  y: number;
}

/** Pack measured rectangles left-to-right, wrapping onto compact rows. */
function packRows<T>(items: readonly RowItem<T>[]): {
  items: PackedRowItem<T>[];
  width: number;
  height: number;
} {
  const packed: PackedRowItem<T>[] = [];
  let x = 0;
  let rowY = 0;
  let rowH = 0;
  let width = 0;
  for (const item of items) {
    if (x > 0 && x + item.width > ROW_MAX_W) {
      rowY += rowH + GAP_Y;
      x = 0;
      rowH = 0;
    }
    packed.push({ ...item, x, y: rowY });
    width = Math.max(width, x + item.width);
    rowH = Math.max(rowH, item.height);
    x += item.width + GAP_X;
  }
  return { items: packed, width, height: rowY + rowH };
}

/** Undirected components of the edges that remain inside one parent scope. */
function connectedComponents(graph: ArchitectureGraph, ids: readonly string[]): string[][] {
  const orderedIds = [...ids].sort((a, b) => a.localeCompare(b));
  const scope = new Set(orderedIds);
  const adjacent = new Map(orderedIds.map((id) => [id, new Set<string>()]));
  for (const edge of graph.edges) {
    if (edge.source === edge.target || !scope.has(edge.source) || !scope.has(edge.target)) continue;
    adjacent.get(edge.source)!.add(edge.target);
    adjacent.get(edge.target)!.add(edge.source);
  }

  const seen = new Set<string>();
  const components: string[][] = [];
  for (const start of orderedIds) {
    if (seen.has(start)) continue;
    const component: string[] = [];
    const pending = [start];
    seen.add(start);
    while (pending.length > 0) {
      const id = pending.pop()!;
      component.push(id);
      const neighbors = [...adjacent.get(id)!].sort((a, b) => b.localeCompare(a));
      for (const neighbor of neighbors) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        pending.push(neighbor);
      }
    }
    component.sort((a, b) => a.localeCompare(b));
    components.push(component);
  }
  return components.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

interface FlowBlock {
  nodes: { id: string; x: number; y: number }[];
  width: number;
  height: number;
}

function layoutFlowBlock(
  graph: ArchitectureGraph,
  ids: string[],
  dims: Map<string, { width: number; height: number }>,
): FlowBlock {
  if (ids.length === 1) {
    const id = ids[0]!;
    const size = dims.get(id)!;
    return { nodes: [{ id, x: 0, y: 0 }], ...size };
  }

  const pass = dagrePass(graph, ids, dims, new Set(ids));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [id, pos] of pass) {
    const size = dims.get(id)!;
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + size.width);
    maxY = Math.max(maxY, pos.y + size.height);
  }
  return {
    nodes: [...pass].map(([id, pos]) => ({ id, x: pos.x - minX, y: pos.y - minY })),
    width: maxX - minX,
    height: maxY - minY,
  };
}

function layoutScopeFlow(
  graph: ArchitectureGraph,
  ids: string[],
  dims: Map<string, { width: number; height: number }>,
  positions: Map<string, { x: number; y: number }>,
  nested: boolean,
): void {
  const blocks = connectedComponents(graph, ids).map((component) =>
    layoutFlowBlock(graph, component, dims),
  );
  const packed = packRows(
    blocks.map((block) => ({ item: block, width: block.width, height: block.height })),
  );
  const x0 = nested ? PADDING_X : 0;
  const y0 = nested ? PADDING_Y : 0;
  for (const placed of packed.items) {
    for (const node of placed.item.nodes) {
      positions.set(node.id, { x: x0 + placed.x + node.x, y: y0 + placed.y + node.y });
    }
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
  for (const band of bands) band.ids.sort((a, b) => a.localeCompare(b));

  interface LaidBand {
    nodes: { id: string; x: number; y: number }[];
    width: number;
    height: number;
  }
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
    const packed = packRows(
      ordered.map((id) => {
        const size = dims.get(id)!;
        return { item: id, ...size };
      }),
    );
    laid.push({
      nodes: packed.items.map(({ item: id, x, y }) => ({ id, x, y })),
      width: packed.width,
      height: packed.height,
    });
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

/**
 * Horizontal variant of `layoutScopeLayers` for fullstack scopes: stack
 * columns run left-to-right (frontend → boundary → services → data), members
 * flowing top-down in wrapped vertical columns inside each band.
 */
function layoutScopeStacks(
  graph: ArchitectureGraph,
  ids: string[],
  dims: Map<string, { width: number; height: number }>,
  positions: Map<string, { x: number; y: number }>,
  nested: boolean,
): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const bands = STACK_ORDER.map((band) => ({ band, ids: [] as string[] }));
  for (const id of ids) {
    const band = scopeStackBandOf(graph, byId.get(id)!);
    bands[STACK_ORDER.indexOf(band)]!.ids.push(id);
  }
  for (const band of bands) band.ids.sort((a, b) => a.localeCompare(b));

  interface LaidBand {
    nodes: { id: string; x: number; y: number }[];
    width: number;
    height: number;
  }
  const BAND_MAX_H = 760;
  const GAP_X = 36;
  const GAP_Y = 36;
  const laid: LaidBand[] = [];
  for (const band of bands) {
    if (band.ids.length === 0) continue;
    // Dagre yields the top-to-bottom ordering; members are then placed in
    // wrapped vertical columns (the transpose of the horizontal-bands case).
    const pass = dagrePass(graph, band.ids, dims, new Set(band.ids));
    const ordered = [...pass.entries()]
      .sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x)
      .map(([id]) => id);
    const nodes: LaidBand["nodes"] = [];
    let y = 0;
    let colX = 0;
    let colW = 0;
    let height = 0;
    for (const id of ordered) {
      const d = dims.get(id)!;
      if (y > 0 && y + d.height > BAND_MAX_H) {
        colX += colW + GAP_X;
        y = 0;
        colW = 0;
      }
      nodes.push({ id, x: colX, y });
      height = Math.max(height, y + d.height);
      colW = Math.max(colW, d.width);
      y += d.height + GAP_Y;
    }
    laid.push({ nodes, width: colX + colW, height });
  }

  const maxHeight = Math.max(0, ...laid.map((b) => b.height));
  const y0 = nested ? PADDING_Y : 0;
  let x = nested ? PADDING_X : 0;
  for (const band of laid) {
    const center = (maxHeight - band.height) / 2;
    for (const n of band.nodes) positions.set(n.id, { x: x + n.x, y: y0 + center + n.y });
    x += band.width + BAND_GAP;
  }
}
