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
}

export interface ElkLayoutResult {
  /** Parent-relative positions and ELK-fitted pen sizes. */
  graph: ArchitectureGraph;
  /** Absolute-canvas orthogonal polylines, keyed by architecture edge id. */
  routes: ReadonlyMap<string, { x: number; y: number }[]>;
}

type Point = { x: number; y: number };

const COMPOUND_PADDING = "[top=56,left=24,bottom=24,right=24]";
const FALLBACK_CARD = { width: 200, height: 84 } as const;

function rootLayoutOptions(direction: "DOWN" | "RIGHT"): Record<string, string> {
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
    "elk.aspectRatio": "1.7",
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
  routes: ReadonlyMap<string, Point[]>,
  tolerance = 0.5,
): ReadonlyMap<string, Point[]> {
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

  let filtered: Map<string, Point[]> | null = null;
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
 */
export async function elkAutoLayout(
  graph: ArchitectureGraph,
  opts: ElkLayoutOptions = {},
): Promise<ElkLayoutResult> {
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

  const penIds = new Set<string>();
  for (const node of graph.nodes) {
    if (rendersAsPen(node, (childrenOf.get(node.id)?.length ?? 0) > 0)) penIds.add(node.id);
  }

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
    if (penIds.has(node.id)) layoutOptions["elk.padding"] = COMPOUND_PADDING;
    else if (node.kind === "person") {
      layoutOptions["elk.layered.layering.layerConstraint"] = "FIRST";
    } else if (
      parentOf.get(node.id) == null &&
      (node.kind === "external" || node.id.startsWith("ext:"))
    ) {
      layoutOptions["elk.layered.layering.layerConstraint"] = "LAST";
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
    layoutOptions: rootLayoutOptions(opts.direction ?? "DOWN"),
  };
  elkById.set(rootId, elkRoot);

  for (const edge of graph.edges) {
    if (edge.source === edge.target || !byId.has(edge.source) || !byId.has(edge.target)) {
      continue;
    }
    const ownerId = nearestCommonAncestor(edge.source, edge.target, parentOf, rootId);
    const owner = elkById.get(ownerId);
    if (!owner) throw new Error(`Missing ELK edge container ${ownerId}`);
    const elkEdge: ElkExtendedEdge = {
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
      container: ownerId,
    };
    (owner.edges ??= []).push(elkEdge);
  }

  // The bundled build runs in-process; these graphs are small enough that a
  // worker only adds startup and serialization variability.
  const laidOut = await new ELK().layout(elkRoot);

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

  const routes = new Map<string, ElkPoint[]>();
  for (const { edge, fallbackOrigin } of edgeLocations) {
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
    if (points.length > 0) routes.set(edge.id, points);
  }

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
