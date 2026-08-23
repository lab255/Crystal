import {
  setC4Position,
  setNodeOverride,
  type ArchNode,
  type ArchNodeOverride,
  type ArchOverlay,
  type ArchitectureGraph,
  type C4Projection,
  type C4View,
} from "@crystal/core";
import { estimateGraphDims } from "./card-metrics.js";
import type { FlowProjection } from "./dataflow.js";

/**
 * The C4 architecture view's edit model. The canvas edits a *projection* —
 * filtered, aggregated, re-parented — so the classic whole-graph
 * `extractOverlay` diff cannot apply (everything the level hides would read
 * as deleted). Edits translate to targeted overlay ops instead:
 *
 *  - drags        → per-level pins in `overlay.c4Layouts[viewKey]`
 *  - field edits  → `overrides[id]` (canonical ids and C4 aggregates alike —
 *                   `reconcileOverlay` is told the aggregate ids are known)
 *  - added nodes  → `manualNodes` (parented only to nodes the canonical
 *                   composition knows; a C4-aggregate parent is display-only)
 *  - added edges  → `manualEdges` (aggregate endpoints allowed — projections
 *                   re-attach them; the composition drops them as dangling)
 *  - deletions    → `hiddenIds`/`hiddenEdgeIds` for derived ids, removal for
 *                   manual ones. Deleting an aggregate (a container card, the
 *                   boundary) is a no-op: it derives right back — hide the
 *                   components inside it instead.
 */

const OVERRIDABLE = ["label", "kind", "description", "tech", "accent", "href", "layer", "sim"] as const;

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const C4_AGGREGATE_HINT = "derived — hide its components instead";
export const C4_AGGREGATE_DELETE_NOTICE =
  "Container cards derive from the code — hide components instead";

/** Projection-only C4 elements re-derive and cannot be removed durably. */
export function isC4AggregateId(id: string, kind: "node" | "edge"): boolean {
  if (kind === "edge") return id.startsWith("c4rel:");
  return id.startsWith("ctr:") || id.startsWith("cmp:") || id.startsWith("c4:") || id === "person:user";
}

/** Split a React Flow delete batch before any subtree-inclusive graph operation runs. */
export function filterC4DeletionIds(
  ids: readonly string[],
  kind: "node" | "edge",
): { deletable: string[]; blocked: string[] } {
  const deletable: string[] = [];
  const blocked: string[] = [];
  for (const id of ids) (isC4AggregateId(id, kind) ? blocked : deletable).push(id);
  return { deletable, blocked };
}

export function c4AddRejection(view: C4View): string | null {
  return view.level === "components"
    ? "Components derive from code — switch to Containers to add a node, or draw an edge to place it."
    : null;
}

export function applyC4Edit(args: {
  overlay: ArchOverlay;
  /** The pure derivation — decides which ids can be hidden vs removed. */
  derived: ArchitectureGraph;
  /** What the canvas showed (projected, laid out, pinned). */
  projected: ArchitectureGraph;
  /** What the canvas reports after the edit. */
  edited: ArchitectureGraph;
  viewKey: string;
  /**
   * The projection's node roll-up — lets a facet removal of an aggregate
   * also release the canonical members that rolled into it.
   */
  nodeRollup?: Record<string, string>;
}): ArchOverlay {
  const { derived, projected, edited, viewKey } = args;
  let overlay = args.overlay;
  const derivedIds = new Set(derived.nodes.map((n) => n.id));
  const derivedEdgeIds = new Set(derived.edges.map((e) => e.id));
  const projectedById = new Map(projected.nodes.map((n) => [n.id, n]));
  const editedIds = new Set(edited.nodes.map((n) => n.id));
  const manualById = new Map(overlay.manualNodes.map((n) => [n.id, n]));

  const manualNodes = [...overlay.manualNodes];
  let manualNodesChanged = false;

  for (const node of edited.nodes) {
    const shown = projectedById.get(node.id);
    if (!shown) {
      // Added on this canvas. New manual node — parent only if the canonical
      // composition would resolve it; a C4 aggregate parent is display-only.
      if (!derivedIds.has(node.id) && !manualById.has(node.id)) {
        const parentOk =
          node.parentId != null &&
          (derivedIds.has(node.parentId) || manualById.has(node.parentId));
        manualNodes.push({ ...node, parentId: parentOk ? node.parentId : null });
        manualNodesChanged = true;
        overlay = setC4Position(overlay, viewKey, node.id, { ...node.position });
      }
      continue;
    }
    // Drag → per-level pin.
    if (node.position.x !== shown.position.x || node.position.y !== shown.position.y) {
      overlay = setC4Position(overlay, viewKey, node.id, { ...node.position });
    }
    // Field edits → override (or the manual node itself).
    const patch: ArchNodeOverride = {};
    for (const key of OVERRIDABLE) {
      if (!sameJson(node[key], shown[key])) {
        (patch as Record<string, unknown>)[key] = node[key] ?? null;
      }
    }
    if (Object.keys(patch).length > 0) {
      const manual = manualById.get(node.id);
      if (manual) {
        const idx = manualNodes.findIndex((n) => n.id === node.id);
        if (idx >= 0) {
          manualNodes[idx] = { ...manualNodes[idx]!, ...patch } as ArchNode;
          manualNodesChanged = true;
        }
      } else {
        overlay = setNodeOverride(overlay, node.id, patch);
      }
    }
  }

  // Deletions.
  const hiddenIds = new Set(overlay.hiddenIds);
  let hiddenChanged = false;
  for (const node of projected.nodes) {
    if (editedIds.has(node.id)) continue;
    if (derivedIds.has(node.id)) {
      if (!hiddenIds.has(node.id)) {
        hiddenIds.add(node.id);
        hiddenChanged = true;
      }
    } else if (manualById.has(node.id)) {
      const idx = manualNodes.findIndex((n) => n.id === node.id);
      if (idx >= 0) {
        manualNodes.splice(idx, 1);
        manualNodesChanged = true;
      }
    }
    // Projection-only nodes (aggregates and schema: entities) re-derive —
    // deletion is a deliberate no-op rather than a manual-node mutation.
  }

  // Edges: additions and label/kind edits land in manualEdges; deletions of
  // derived edges hide them, of manual edges remove them.
  const projectedEdgeById = new Map(projected.edges.map((e) => [e.id, e]));
  const editedEdgeIds = new Set(edited.edges.map((e) => e.id));
  const manualEdges = [...overlay.manualEdges];
  let manualEdgesChanged = false;
  const manualEdgeIdx = new Map(manualEdges.map((e, i) => [e.id, i]));
  for (const edge of edited.edges) {
    const shown = projectedEdgeById.get(edge.id);
    if (!shown) {
      if (!manualEdgeIdx.has(edge.id)) {
        manualEdges.push(edge);
        manualEdgesChanged = true;
      }
      continue;
    }
    if (edge.kind !== shown.kind || edge.label !== shown.label) {
      const idx = manualEdgeIdx.get(edge.id);
      if (idx != null) manualEdges[idx] = edge;
      else if (derivedEdgeIds.has(edge.id)) manualEdges.push(edge);
      // Aggregate (`c4rel:`) label/kind edits do not persist — they re-derive.
      manualEdgesChanged = true;
    }
  }
  const hiddenEdgeIds = new Set(overlay.hiddenEdgeIds);
  let hiddenEdgesChanged = false;
  for (const edge of projected.edges) {
    if (editedEdgeIds.has(edge.id)) continue;
    // An edge that vanished with its deleted endpoint is not a deliberate
    // edge deletion — the node op already covers it.
    if (!editedIds.has(edge.source) || !editedIds.has(edge.target)) continue;
    if (derivedEdgeIds.has(edge.id)) {
      if (!hiddenEdgeIds.has(edge.id)) {
        hiddenEdgeIds.add(edge.id);
        hiddenEdgesChanged = true;
      }
    } else {
      const idx = manualEdgeIdx.get(edge.id);
      if (idx != null) {
        manualEdges.splice(idx, 1);
        manualEdgesChanged = true;
        manualEdgeIdx.delete(edge.id);
        for (const [id, i] of manualEdgeIdx) if (i > idx) manualEdgeIdx.set(id, i - 1);
      }
    }
  }

  // Facets: the canvas edits *translated* copies (members mapped through the
  // roll-up), so membership changes apply as deltas against what was shown —
  // adding a container card records the aggregate id (meaningful at C4
  // levels, harmlessly dangling on the flat graph), removing one also
  // releases the canonical members that rolled into it.
  const rollupInto = args.nodeRollup ?? {};
  const projFacetById = new Map(projected.facets.map((f) => [f.id, f]));
  let facets = overlay.facets;
  let facetsChanged = false;
  for (const ef of edited.facets) {
    const pf = projFacetById.get(ef.id);
    if (!pf) {
      facets = [...facets, ef];
      facetsChanged = true;
      continue;
    }
    const before = new Set(pf.nodeIds);
    const after = new Set(ef.nodeIds);
    const added = [...after].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));
    if (added.length === 0 && removed.length === 0) continue;
    facetsChanged = true;
    facets = facets.map((f) => {
      if (f.id !== ef.id) return f;
      const ids = f.nodeIds.filter(
        (id) => !removed.some((r) => id === r || rollupInto[id] === r),
      );
      return { ...f, nodeIds: [...new Set([...ids, ...added])] };
    });
  }

  if (
    overlay === args.overlay &&
    !manualNodesChanged &&
    !manualEdgesChanged &&
    !hiddenChanged &&
    !hiddenEdgesChanged &&
    !facetsChanged
  ) return args.overlay;

  return {
    ...overlay,
    ...(manualNodesChanged ? { manualNodes } : {}),
    ...(manualEdgesChanged ? { manualEdges } : {}),
    ...(hiddenChanged ? { hiddenIds: [...hiddenIds] } : {}),
    ...(hiddenEdgesChanged ? { hiddenEdgeIds: [...hiddenEdgeIds] } : {}),
    ...(facetsChanged ? { facets } : {}),
  };
}

/**
 * Facet membership mapped through a projection so a lens keeps meaning at
 * every altitude: a member hidden at this level is represented by whatever
 * it rolled up into. A facet whose members have no representative here is
 * left untranslated — its dangling ids show the whole level, the same
 * grace `facetVisibleIds` already gives dangling members.
 */
export function projectFacets(
  facets: ArchitectureGraph["facets"],
  projection: C4Projection,
): ArchitectureGraph["facets"] {
  const visible = new Set(projection.graph.nodes.map((n) => n.id));
  return facets.map((f) => {
    if (f.nodeIds.length === 0) return f;
    const mapped = [
      ...new Set(
        f.nodeIds
          .map((id) => (visible.has(id) ? id : projection.nodeRollup[id]))
          .filter((id): id is string => id != null),
      ),
    ];
    if (mapped.length === 0) return f; // nothing represented here — leave untranslated
    if (mapped.length === f.nodeIds.length && mapped.every((id, i) => id === f.nodeIds[i]))
      return f;
    return { ...f, nodeIds: mapped };
  });
}

/**
 * Overrides keyed on C4 aggregate ids (a renamed container, an accented
 * boundary) are invisible to `composeArchitecture` — the aggregates never
 * reach it. Apply them to a projection instead, skipping ids the canonical
 * graph knows (those already composed upstream — applying twice would stack).
 */
export function applyAggregateOverrides(
  graph: ArchitectureGraph,
  overrides: Record<string, ArchNodeOverride>,
  canonicalIds: ReadonlySet<string>,
): ArchitectureGraph {
  let touched = false;
  const nodes = graph.nodes.map((n) => {
    if (canonicalIds.has(n.id)) return n;
    const o = overrides[n.id];
    if (!o) return n;
    touched = true;
    const out: ArchNode = { ...n };
    if (o.label !== undefined) out.label = o.label;
    if (o.kind !== undefined) out.kind = o.kind;
    if (o.description !== undefined) out.description = o.description;
    if (o.tech !== undefined) out.tech = o.tech;
    if (o.accent !== undefined) out.accent = o.accent;
    if (o.href !== undefined) out.href = o.href;
    if (o.layer !== undefined) out.layer = o.layer;
    if (o.sim !== undefined) out.sim = o.sim;
    return out;
  });
  return touched ? { ...graph, nodes } : graph;
}

/**
 * Reserved layout footprints for the C4 card tiers, so the boxes read at the
 * generous sizes C4 diagrams conventionally use (and container cards keep a
 * stable slot for the zoom-into-code expansion their `codeModule` allows).
 */
export function c4Reserve(
  graph: ArchitectureGraph,
  base?: ReadonlyMap<string, { width: number; height: number }>,
): Map<string, { width: number; height: number }> {
  const reserve = estimateGraphDims(graph);
  for (const n of graph.nodes) {
    const estimated = reserve.get(n.id);
    if (n.kind === "container" && estimated) {
      // C4 container cards stay visually generous even when their current
      // content is short. Height remains content-driven so sparse diagrams
      // no longer reserve blanket 300x170 rectangles.
      reserve.set(n.id, { ...estimated, width: Math.max(260, estimated.width) });
    }
  }
  // Measured/system-card slots supplied by the caller are authoritative.
  for (const [id, size] of base ?? []) reserve.set(id, size);
  return reserve;
}

/**
 * Re-key a journey flow through a projection: hidden nodes and edges follow
 * their roll-ups so the lens stays truthful at every altitude (a hop between
 * two components of one container disappears into it; a cross-container hop
 * lights the aggregate relationship).
 */
export function remapFlowProjection(
  flow: FlowProjection,
  projection: C4Projection,
): FlowProjection {
  const visibleNodes = new Set(projection.graph.nodes.map((n) => n.id));
  const visibleEdges = new Set(projection.graph.edges.map((e) => e.id));
  const nodeOf = (id: string): string | null =>
    visibleNodes.has(id) ? id : (projection.nodeRollup[id] ?? null);

  const firstStep = new Map<string, number>();
  for (const o of flow.nodeOrder) {
    const id = nodeOf(o.nodeId);
    if (!id) continue;
    const prev = firstStep.get(id);
    if (prev == null || o.firstStep < prev) firstStep.set(id, o.firstStep);
  }

  const edgeSteps = new Map<string, number[]>();
  for (const [edgeId, steps] of flow.edgeSteps) {
    const id = visibleEdges.has(edgeId) ? edgeId : (projection.edgeRollup[edgeId] ?? null);
    if (!id || !visibleEdges.has(id)) continue;
    edgeSteps.set(id, [...new Set([...(edgeSteps.get(id) ?? []), ...steps])].sort((a, b) => a - b));
  }

  const ghostHops: FlowProjection["ghostHops"] = [];
  const seenHops = new Set<string>();
  for (const hop of flow.ghostHops) {
    const source = nodeOf(hop.source);
    const target = nodeOf(hop.target);
    if (!source || !target || source === target) continue;
    const key = `${source}->${target}`;
    if (seenHops.has(key)) continue;
    seenHops.add(key);
    ghostHops.push({ source, target, step: hop.step });
  }

  const stepNodeIds = new Map<string, string>();
  for (const [key, nodeId] of flow.stepNodeIds) {
    const id = nodeOf(nodeId);
    if (id) stepNodeIds.set(key, id);
  }

  return {
    nodeOrder: [...firstStep.entries()]
      .map(([nodeId, step]) => ({ nodeId, firstStep: step }))
      .sort((a, b) => a.firstStep - b.firstStep),
    edgeSteps,
    ghostHops,
    unmappedSteps: flow.unmappedSteps,
    stepNodeIds,
  };
}
