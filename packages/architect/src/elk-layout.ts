import ELK, {
  type ElkExtendedEdge,
  type ElkNode,
  type ElkPoint,
} from "elkjs/lib/elk.bundled.js";
import { type ArchNode, type ArchitectureGraph } from "@crystal/core";
import { estimateCardSize, rendersAsPen } from "./card-metrics.js";

export interface ElkLayoutOptions {
  /** Authoritative browser measurements, or deterministic estimates upstream. */
  dims?: ReadonlyMap<string, { width: number; height: number }>;
  direction?: "DOWN" | "RIGHT";
  /** Width / height of the canvas the packed result should fill. */
  aspectRatio?: number;
  /** Parent-relative positions from the last structurally similar solve. */
  previous?: ReadonlyMap<string, { x: number; y: number }>;
  /** Enables ELK's conservative semi-interactive ordering hints. */
  incremental?: boolean;
}

export interface ElkLayoutEngine {
  layout(graph: ElkNode): Promise<ElkNode>;
}

export interface ElkRouteLabel {
  /** Absolute-canvas top-left corner and estimated/rendered footprint. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElkRoute {
  /** Absolute-canvas orthogonal polyline. */
  points: { x: number; y: number }[];
  /** ELK-provided or deterministically de-collided label box. */
  label?: ElkRouteLabel;
}

export interface ElkLayoutResult {
  /** Parent-relative positions and ELK-fitted pen sizes. */
  graph: ArchitectureGraph;
  /** Absolute-canvas routes and label boxes, keyed by architecture edge id. */
  routes: ReadonlyMap<string, ElkRoute>;
}

const LAYER_CONSTRAINT_OPTION = "elk.layered.layering.layerConstraint";

function stripLayerConstraints(node: ElkNode): void {
  if (node.layoutOptions) delete node.layoutOptions[LAYER_CONSTRAINT_OPTION];
  for (const child of node.children ?? []) stripLayerConstraints(child);
}

async function layoutWithConstraintRetry(
  engine: ElkLayoutEngine,
  graph: ElkNode,
): Promise<ElkNode> {
  try {
    return await engine.layout(graph);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("UnsupportedConfigurationException")) throw error;
    stripLayerConstraints(graph);
    return engine.layout(graph);
  }
}

type Point = { x: number; y: number };

const COMPOUND_PADDING = "[top=56,left=24,bottom=24,right=24]";
const FALLBACK_CARD = { width: 200, height: 84 } as const;
const DEFAULT_ASPECT_RATIO = 1.7;
const EDGE_LABEL_FONT_SIZE = 10;
const EDGE_LABEL_AVERAGE_GLYPH_WIDTH = 5.5;
const EDGE_LABEL_HORIZONTAL_PADDING = 8;
const EDGE_LABEL_VERTICAL_PADDING = 2;
const EDGE_LABEL_LINE_HEIGHT = 15;
const EDGE_LABEL_SPACING = 12;

/** Mirrors ElkEdge's 10px, single-line label with px-1 / py-px padding. */
export function estimateEdgeLabelSize(text: string): { width: number; height: number } {
  return {
    width:
      [...text].length * EDGE_LABEL_AVERAGE_GLYPH_WIDTH + EDGE_LABEL_HORIZONTAL_PADDING,
    height: Math.max(EDGE_LABEL_FONT_SIZE, EDGE_LABEL_LINE_HEIGHT) + EDGE_LABEL_VERTICAL_PADDING,
  };
}

function edgeLabelLayoutOptions(): Record<string, string> {
  return {
    "org.eclipse.elk.edgeLabels.inline": "true",
    "org.eclipse.elk.spacing.edgeLabel": String(EDGE_LABEL_SPACING),
    "org.eclipse.elk.spacing.labelLabel": "8",
    "org.eclipse.elk.layered.edgeLabels.sideSelection": "SMART_DOWN",
  };
}

function rootLayoutOptions(
  direction: "DOWN" | "RIGHT",
  aspectRatio: number,
  incremental: boolean,
): Record<string, string> {
  return {
    "elk.algorithm": "layered",
    "elk.direction": direction,
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.layered.spacing.nodeNodeBetweenLayers": "64",
    "elk.spacing.nodeNode": "40",
    "elk.spacing.componentComponent": "64",
    "elk.spacing.edgeNode": "24",
    "elk.spacing.edgeEdge": "12",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    "elk.separateConnectedComponents": "true",
    "elk.aspectRatio": String(aspectRatio),
    ...edgeLabelLayoutOptions(),
    ...(incremental
      ? {
          "elk.interactive": "true",
          "org.eclipse.elk.layered.crossingMinimization.semiInteractive": "true",
        }
      : {}),
  };
}

function finite(value: number | undefined, description: string): number {
  if (value == null || !Number.isFinite(value)) {
    throw new Error(`ELK produced a non-finite ${description}`);
  }
  return value;
}

function finiteSize(
  size: { width: number; height: number } | undefined,
  nodeId: string,
): { width: number; height: number } | undefined {
  if (!size) return undefined;
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) {
    throw new Error(`Non-finite layout dimensions for node ${nodeId}`);
  }
  return { width: size.width, height: size.height };
}

/**
 * The ELK root is synthetic, so keep its id outside the architecture id set.
 * The suffix loop also makes the unlikely collision case deterministic.
 */
function rootIdFor(nodes: ReadonlyMap<string, ArchNode>): string {
  let id = "__crystal_elk_root__";
  while (nodes.has(id)) id += ":root";
  return id;
}

/** Nearest common ancestor in the normalized ELK containment tree. */
function nearestCommonAncestor(
  source: string,
  target: string,
  parentOf: ReadonlyMap<string, string | null>,
  rootId: string,
): string {
  const sourceAncestors = new Set<string>();
  let cursor: string | null = source;
  while (cursor != null) {
    sourceAncestors.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
  cursor = target;
  while (cursor != null) {
    if (sourceAncestors.has(cursor)) return cursor;
    cursor = parentOf.get(cursor) ?? null;
  }
  return rootId;
}

function absolutePoint(point: ElkPoint, origin: ElkPoint, edgeId: string): ElkPoint {
  const x = finite(point.x, `route x for edge ${edgeId}`) + origin.x;
  const y = finite(point.y, `route y for edge ${edgeId}`) + origin.y;
  return { x, y };
}

/** Append while removing only exact section-boundary duplicates. */
function appendPoint(points: ElkPoint[], point: ElkPoint): void {
  const previous = points[points.length - 1];
  if (!previous || previous.x !== point.x || previous.y !== point.y) points.push(point);
}

function longestSegmentLabelPlacement(
  points: readonly Point[],
  size: { width: number; height: number },
): { box: ElkRouteLabel; direction: Point } {
  let longest = -1;
  let midpoint = points[0] ?? { x: 0, y: 0 };
  let direction = { x: 1, y: 0 };
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length <= longest) continue;
    longest = length;
    midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    if (length > 0) direction = { x: dx / length, y: dy / length };
  }
  return {
    box: {
      x: midpoint.x - size.width / 2,
      y: midpoint.y - size.height / 2,
      ...size,
    },
    direction,
  };
}

function labelBoxesOverlap(a: ElkRouteLabel, b: ElkRouteLabel): boolean {
  const gap = EDGE_LABEL_SPACING / 2;
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}

/**
 * Fill in labels ELK could not position, in edge-id order. Existing ELK
 * boxes stay fixed; fallback boxes walk in alternating steps along their
 * longest route segment until they no longer collide.
 */
export function placeFallbackEdgeLabels(
  routes: ReadonlyMap<string, ElkRoute>,
  labels: ReadonlyMap<string, string>,
): ReadonlyMap<string, ElkRoute> {
  const placed = new Map<string, ElkRoute>();
  for (const [id, route] of routes) {
    placed.set(id, {
      points: route.points.map((point) => ({ ...point })),
      ...(route.label ? { label: { ...route.label } } : {}),
    });
  }

  // ELK-planned boxes have priority regardless of their edge ids.
  const occupied = [...placed.values()].flatMap((route) =>
    route.label ? [route.label] : [],
  );
  for (const id of [...placed.keys()].sort((a, b) => a.localeCompare(b))) {
    const route = placed.get(id)!;
    const text = labels.get(id)?.trim();
    if (!text || route.label || route.points.length === 0) continue;
    const size = estimateEdgeLabelSize(text);
    const initial = longestSegmentLabelPlacement(route.points, size);
    const step = Math.max(size.width, size.height) + EDGE_LABEL_SPACING;
    let box = initial.box;
    for (let attempt = 0; occupied.some((other) => labelBoxesOverlap(box, other)); attempt += 1) {
      // +1, -1, +2, -2... keeps a parallel bundle centered as it grows.
      const multiple = Math.floor(attempt / 2) + 1;
      const sign = attempt % 2 === 0 ? 1 : -1;
      const offset = sign * multiple * step;
      box = {
        ...initial.box,
        x: initial.box.x + initial.direction.x * offset,
        y: initial.box.y + initial.direction.y * offset,
      };
    }
    route.label = box;
    occupied.push(box);
  }
  return placed;
}

/**
 * Resolve parent-relative node positions into canvas coordinates. Keeping
 * this beside the route producer makes its coordinate contract explicit:
 * ELK routes are absolute, while architecture node positions are not.
 */
function absolutePositions(graph: ArchitectureGraph): Map<string, Point> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const absolute = new Map<string, Point>();
  const visiting = new Set<string>();
  const resolve = (id: string): Point | null => {
    const cached = absolute.get(id);
    if (cached) return cached;
    const node = byId.get(id);
    if (!node || visiting.has(id)) return null;
    visiting.add(id);
    const parent = node.parentId ? resolve(node.parentId) : { x: 0, y: 0 };
    visiting.delete(id);
    if (!parent) return null;
    const point = { x: parent.x + node.position.x, y: parent.y + node.position.y };
    absolute.set(id, point);
    return point;
  };
  for (const node of graph.nodes) resolve(node.id);
  return absolute;
}

/**
 * Routed polylines describe one exact ELK geometry. A pin on either endpoint
 * (or on one of its parents) makes that geometry stale, so let React Flow
 * fall back to its live endpoint-based edge for that edge only.
 */
export function filterRoutesForMovedEndpoints(
  laid: ArchitectureGraph,
  displayed: ArchitectureGraph,
  routes: ReadonlyMap<string, ElkRoute>,
  tolerance = 0.5,
): ReadonlyMap<string, ElkRoute> {
  const laidAbsolute = absolutePositions(laid);
  const displayedAbsolute = absolutePositions(displayed);
  const moved = (id: string): boolean => {
    const before = laidAbsolute.get(id);
    const after = displayedAbsolute.get(id);
    return (
      !before ||
      !after ||
      Math.abs(before.x - after.x) > tolerance ||
      Math.abs(before.y - after.y) > tolerance
    );
  };

  let filtered: Map<string, ElkRoute> | null = null;
  for (const edge of laid.edges) {
    if (!routes.has(edge.id) || (!moved(edge.source) && !moved(edge.target))) continue;
    filtered ??= new Map(routes);
    filtered.delete(edge.id);
  }
  return filtered ?? routes;
}

/**
 * Compound, hierarchical ELK layout for the architecture canvas.
 *
 * Edges live at the nearest scope containing both endpoints. That is the
 * detail ELK's hierarchy support relies on: leaving every edge on the root
 * makes nested endpoints route as if their parent boundaries did not exist.
 * Architecture callers pass `splitInfraOnly(graph).view`; ELK's exact-visit
 * assertions therefore cover only nodes belonging to that projection.
 */
export async function elkAutoLayout(
  graph: ArchitectureGraph,
  opts: ElkLayoutOptions = {},
  engine: ElkLayoutEngine = new ELK(),
): Promise<ElkLayoutResult> {
  const aspectRatio = opts.aspectRatio ?? DEFAULT_ASPECT_RATIO;
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    throw new Error(`Invalid ELK aspect ratio ${aspectRatio}`);
  }
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const rootId = rootIdFor(byId);

  // Dangling parents are normalized to root so every architecture node still
  // participates. Valid parentId nesting is preserved byte-for-byte.
  const parentOf = new Map<string, string | null>();
  const childrenOf = new Map<string | null, ArchNode[]>();
  for (const node of graph.nodes) {
    const parent = node.parentId != null && byId.has(node.parentId) ? node.parentId : null;
    parentOf.set(node.id, parent);
    const siblings = childrenOf.get(parent) ?? [];
    siblings.push(node);
    childrenOf.set(parent, siblings);
  }
  for (const siblings of childrenOf.values()) {
    siblings.sort((a, b) => a.id.localeCompare(b.id));
  }

  const penIds = new Set<string>();
  for (const node of graph.nodes) {
    if (rendersAsPen(node, (childrenOf.get(node.id)?.length ?? 0) > 0)) penIds.add(node.id);
  }

  // Edges-per-scope, counted at each edge's owning scope (its endpoints'
  // nearest common ancestor — the same attachment rule used below). A scope
  // that owns few edges relative to its population is mostly disconnected
  // members, which layered layout strings into one endless row: hierarchical
  // layout ignores connected-component packing, so those scopes switch to
  // rectangle packing instead (edges barely order anything there anyway).
  const scopeEdgeCount = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.source === edge.target || !byId.has(edge.source) || !byId.has(edge.target)) continue;
    const ownerId = nearestCommonAncestor(edge.source, edge.target, parentOf, rootId);
    scopeEdgeCount.set(ownerId, (scopeEdgeCount.get(ownerId) ?? 0) + 1);
  }
  const SPARSE_MIN_CHILDREN = 8;
  const sparseScope = (id: string): boolean => {
    const population = childrenOf.get(id)?.length ?? 0;
    return (
      population >= SPARSE_MIN_CHILDREN && (scopeEdgeCount.get(id) ?? 0) < population / 3
    );
  };

  interface Solved {
    positions: Map<string, ElkPoint>;
    fittedSizes: Map<string, { width: number; height: number }>;
    routes: ReadonlyMap<string, ElkRoute>;
  }

  const solve = async (packedScopes: ReadonlySet<string>): Promise<Solved> => {
    const elkById = new Map<string, ElkNode>();
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const buildNode = (node: ArchNode): ElkNode => {
      if (visiting.has(node.id)) throw new Error(`Architecture containment cycle at ${node.id}`);
      const existing = elkById.get(node.id);
      if (existing) return existing;

      visiting.add(node.id);
      const children = childrenOf.get(node.id) ?? [];
      if (children.length > 0 && !penIds.has(node.id)) {
        throw new Error(`Node ${node.id} has children but does not render as a container pen`);
      }

      const layoutOptions: Record<string, string> = {};
      if (penIds.has(node.id)) {
        layoutOptions["elk.padding"] = COMPOUND_PADDING;
        Object.assign(layoutOptions, edgeLabelLayoutOptions());
        if (packedScopes.has(node.id)) {
          // The scope becomes its own hierarchy boundary: ELK lays its children
          // out first (nested pens still use their own algorithms), then packs
          // the boxes toward the diagram's aspect ratio. Edges into a packed
          // scope lose their routed sections and fall back to plain edges.
          layoutOptions["elk.algorithm"] = "rectpacking";
          layoutOptions["elk.aspectRatio"] = String(aspectRatio);
          layoutOptions["elk.spacing.nodeNode"] = "32";
        }
      } else if (node.kind === "person") {
        layoutOptions[LAYER_CONSTRAINT_OPTION] = "FIRST";
      } else if (
        parentOf.get(node.id) == null &&
        (node.kind === "external" || node.id.startsWith("ext:"))
      ) {
        layoutOptions[LAYER_CONSTRAINT_OPTION] = "LAST";
      }

      let elkNode: ElkNode;
      if (penIds.has(node.id)) {
        const emptyPenSize =
          children.length === 0 ? finiteSize(node.size ?? undefined, node.id) : undefined;
        elkNode = {
          id: node.id,
          children: children.map(buildNode),
          layoutOptions,
          // An explicitly sized empty pen has no child extents for ELK to fit.
          // Preserve that meaningful canvas footprint while still representing
          // the node as a compound in the hierarchy.
          ...(emptyPenSize ? { width: emptyPenSize.width, height: emptyPenSize.height } : {}),
        };
      } else {
        const measured = finiteSize(opts.dims?.get(node.id), node.id);
        const estimated = finiteSize(estimateCardSize(node), node.id);
        const size =
          measured ?? estimated ?? finiteSize(node.size ?? undefined, node.id) ?? FALLBACK_CARD;
        elkNode = { id: node.id, width: size.width, height: size.height, layoutOptions };
      }
      const previous = opts.incremental ? opts.previous?.get(node.id) : undefined;
      if (previous) {
        elkNode.x = finite(previous.x, `previous x for node ${node.id}`);
        elkNode.y = finite(previous.y, `previous y for node ${node.id}`);
      }

      elkById.set(node.id, elkNode);
      visiting.delete(node.id);
      visited.add(node.id);
      return elkNode;
    };

    const rootChildren = (childrenOf.get(null) ?? []).map(buildNode);
    if (visited.size !== graph.nodes.length) {
      // Nodes unreachable from the synthetic root necessarily form a parent
      // cycle. Build one to produce the specific cycle error above.
      const unvisited = graph.nodes.find((node) => !visited.has(node.id));
      if (unvisited) buildNode(unvisited);
    }

    const elkRoot: ElkNode = {
      id: rootId,
      children: rootChildren,
      edges: [],
      layoutOptions: rootLayoutOptions(opts.direction ?? "DOWN", aspectRatio, opts.incremental === true),
    };
    elkById.set(rootId, elkRoot);

    // A packed scope is a hierarchy boundary the outer layered algorithm does
    // not manage — an edge reaching THROUGH that boundary crashes ELK (a Java
    // exception out of the layered/rectpacking interaction). Snap any such
    // endpoint to its outermost packed ancestor: the outer layout still feels
    // the connection, and the rendered edge falls back to endpoint-based
    // drawing because its ELK route would terminate at the pen border anyway.
    const regionOf = (id: string): string | null => {
      let region: string | null = null;
      let cursor: string | null = id;
      while (cursor != null) {
        if (packedScopes.has(cursor)) region = cursor;
        cursor = parentOf.get(cursor) ?? null;
      }
      return region;
    };
    const borderSnapped = new Set<string>();

    for (const edge of [...graph.edges].sort((a, b) => a.id.localeCompare(b.id))) {
      if (edge.source === edge.target || !byId.has(edge.source) || !byId.has(edge.target)) {
        continue;
      }
      let source = edge.source;
      let target = edge.target;
      const sourceRegion = regionOf(source);
      const targetRegion = regionOf(target);
      if (sourceRegion !== targetRegion) {
        if (sourceRegion) source = sourceRegion;
        if (targetRegion) target = targetRegion;
        if (source === target) continue;
        borderSnapped.add(edge.id);
      }
      const ownerId = nearestCommonAncestor(source, target, parentOf, rootId);
      const owner = elkById.get(ownerId);
      if (!owner) throw new Error(`Missing ELK edge container ${ownerId}`);
      const elkEdge: ElkExtendedEdge = {
        id: edge.id,
        sources: [source],
        targets: [target],
        container: ownerId,
        ...(edge.label.trim() && !borderSnapped.has(edge.id)
          ? {
              labels: [
                {
                  text: edge.label,
                  ...estimateEdgeLabelSize(edge.label),
                  layoutOptions: {
                    "org.eclipse.elk.edgeLabels.placement": "CENTER",
                    "org.eclipse.elk.edgeLabels.inline": "true",
                  },
                },
              ],
            }
          : {}),
      };
      (owner.edges ??= []).push(elkEdge);
    }

    const laidOut = await layoutWithConstraintRetry(engine, elkRoot);

    const positions = new Map<string, ElkPoint>();
    const fittedSizes = new Map<string, { width: number; height: number }>();
    const absoluteOrigins = new Map<string, ElkPoint>([[rootId, { x: 0, y: 0 }]]);
    const edgeLocations: { edge: ElkExtendedEdge; fallbackOrigin: ElkPoint }[] = [];

    const readNode = (node: ElkNode, parentOrigin: ElkPoint): void => {
      const x = finite(node.x, `x coordinate for node ${node.id}`);
      const y = finite(node.y, `y coordinate for node ${node.id}`);
      const width = finite(node.width, `width for node ${node.id}`);
      const height = finite(node.height, `height for node ${node.id}`);
      const origin = { x: parentOrigin.x + x, y: parentOrigin.y + y };

      positions.set(node.id, { x, y });
      absoluteOrigins.set(node.id, origin);
      if (penIds.has(node.id)) fittedSizes.set(node.id, { width, height });
      for (const edge of node.edges ?? []) edgeLocations.push({ edge, fallbackOrigin: origin });
      for (const child of node.children ?? []) readNode(child, origin);
    };

    finite(laidOut.width, "root width");
    finite(laidOut.height, "root height");
    for (const edge of laidOut.edges ?? []) {
      edgeLocations.push({ edge, fallbackOrigin: { x: 0, y: 0 } });
    }
    for (const child of laidOut.children ?? []) readNode(child, { x: 0, y: 0 });
    if (positions.size !== graph.nodes.length) {
      throw new Error("ELK omitted one or more architecture nodes");
    }

    const routes = new Map<string, ElkRoute>();
    for (const { edge, fallbackOrigin } of edgeLocations) {
      if (borderSnapped.has(edge.id)) continue;
      if (!edge.sections || edge.sections.length === 0) continue;
      const origin = edge.container
        ? (absoluteOrigins.get(edge.container) ?? fallbackOrigin)
        : fallbackOrigin;
      const points: ElkPoint[] = [];
      for (const section of edge.sections) {
        appendPoint(points, absolutePoint(section.startPoint, origin, edge.id));
        for (const bend of section.bendPoints ?? []) {
          appendPoint(points, absolutePoint(bend, origin, edge.id));
        }
        appendPoint(points, absolutePoint(section.endPoint, origin, edge.id));
      }
      if (points.length > 0) {
        const label = edge.labels?.[0];
        const labelBox =
          label?.x != null && label.y != null
            ? {
                x: finite(label.x, `label x for edge ${edge.id}`) + origin.x,
                y: finite(label.y, `label y for edge ${edge.id}`) + origin.y,
                width: finite(label.width, `label width for edge ${edge.id}`),
                height: finite(label.height, `label height for edge ${edge.id}`),
              }
            : undefined;
        routes.set(edge.id, { points, ...(labelBox ? { label: labelBox } : {}) });
      }
    }

    const labels = new Map(
      graph.edges
        .filter((edge) => edge.label.trim().length > 0)
        .map((edge) => [edge.id, edge.label] as const),
    );
    return { positions, fittedSizes, routes: placeFallbackEdgeLabels(routes, labels) };
  };

  // First pass: sparse scopes rectangle-pack pre-emptively. Hub-heavy scopes
  // pass the sparse test (their edges are real) yet still degenerate — one
  // index module fanning out to sixty members puts them all in a single
  // layered rank, an unreadable ribbon. Aspect is checkable only after the
  // fact, so re-solve once with the offending scopes packed too.
  const EXTREME_ASPECT = 4;
  const packed = new Set(
    graph.nodes
      .filter((node) => penIds.has(node.id) && sparseScope(node.id))
      .map((n) => n.id)
      .sort((a, b) => a.localeCompare(b)),
  );
  let solved = await solve(packed);
  const offenders = [...solved.fittedSizes]
    .filter(([id, size]) => {
      if (packed.has(id) || (childrenOf.get(id)?.length ?? 0) === 0) return false;
      const aspect = size.width / size.height;
      return aspect > EXTREME_ASPECT || aspect < 1 / EXTREME_ASPECT;
    })
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b));
  if (offenders.length > 0) {
    for (const id of offenders) packed.add(id);
    solved = await solve(packed);
  }
  const { positions, fittedSizes, routes } = solved;

  return {
    graph: {
      ...graph,
      nodes: graph.nodes.map((node) => {
        const position = positions.get(node.id);
        if (!position) throw new Error(`Missing ELK position for node ${node.id}`);
        const size = fittedSizes.get(node.id);
        return { ...node, position, ...(size ? { size } : {}) };
      }),
    },
    routes,
  };
}
