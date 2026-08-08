import { z } from "zod";
import {
  ArchEdgeSchema,
  ArchEnvironmentSchema,
  ArchFacetSchema,
  ArchLayerSchema,
  ArchNodeKindSchema,
  ArchNodeSchema,
  ArchPlacementSchema,
  JourneySchema,
  SimNodeConfigSchema,
  createLocalEnvironment,
  descendantsOf,
  type ArchNode,
  type ArchitectureGraph,
} from "./architecture.js";

/**
 * The architecture overlay — everything the user adds on top of the derived
 * architecture graph. There is ONE canonical architecture per workspace,
 * re-derived from the code map on every change; the overlay is the durable
 * half: node customizations keyed by canonical id, manual nodes/edges the
 * derivation can't see (queues, buckets, notes, planned services), hidden
 * derived nodes, and the graph-level state that used to live per-diagram
 * (environments, journeys, facets, viewport).
 *
 * Persisted as envelope kind `"arch-overlay"` at
 * `.crystal/architecture/overlay.json`. Composition is pure and worker-safe:
 * `composeArchitecture(derived, overlay)` yields the graph every view renders.
 */

export const ArchNodeOverrideSchema = z.object({
  /** Manual position — both present or neither (a half-set position is noise). */
  x: z.number().optional(),
  y: z.number().optional(),
  /** Re-parenting: a string moves the node, explicit null pins it to root. */
  parentId: z.string().nullish(),
  size: z.object({ width: z.number(), height: z.number() }).nullish(),
  label: z.string().optional(),
  kind: ArchNodeKindSchema.optional(),
  description: z.string().optional(),
  tech: z.array(z.string()).optional(),
  layer: ArchLayerSchema.nullish(),
  accent: z
    .enum(["violet", "cyan", "emerald", "amber", "rose", "blue", "slate"])
    .nullish(),
  href: z.string().nullish(),
  sim: SimNodeConfigSchema.nullish(),
  /** Environment id → placement; merged over the derived node's placements. */
  placements: z.record(ArchPlacementSchema).optional(),
});
export type ArchNodeOverride = z.infer<typeof ArchNodeOverrideSchema>;

export const ArchOverlaySchema = z.object({
  /** Customizations of derived nodes, keyed by canonical node id. */
  overrides: z.record(ArchNodeOverrideSchema).default({}),
  /** Nodes the derivation can't see — queues, buckets, notes, planned services. */
  manualNodes: z.array(ArchNodeSchema).default([]),
  /**
   * User-drawn edges — and *edited* derived edges: a manual edge sharing a
   * derived edge's id overrides it in the composition (kind/label edits).
   */
  manualEdges: z.array(ArchEdgeSchema).default([]),
  /** Derived node ids the user removed from the diagram (subtree-inclusive). */
  hiddenIds: z.array(z.string()).default([]),
  /** Derived edge ids the user removed ("this arrow is wrong"). */
  hiddenEdgeIds: z.array(z.string()).default([]),
  /** Workspace-scoped environments (previously per-diagram). */
  environments: z.array(ArchEnvironmentSchema).default([]),
  journeys: z.array(JourneySchema).default([]),
  facets: z.array(ArchFacetSchema).default([]),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).nullish(),
  /**
   * Manual node positions per C4 view, keyed by `c4ViewKey` ("context",
   * "containers", "components:<ctr>") then node id. A node dragged at one
   * altitude stays put there without disturbing the auto-layout of the
   * others — C4 projections re-arrange the same ids per level, so a single
   * shared position cannot serve them all. Positional-only by construction:
   * entries vanish silently with their node/view (see `reconcileOverlay`).
   */
  c4Layouts: z
    .record(z.record(z.object({ x: z.number(), y: z.number() })))
    .default({}),
});
export type ArchOverlay = z.infer<typeof ArchOverlaySchema>;

export function createArchOverlay(): ArchOverlay {
  return ArchOverlaySchema.parse({ environments: [createLocalEnvironment()] });
}

/** Merge a patch into one node's override, pruning the entry when it empties. */
export function setNodeOverride(
  overlay: ArchOverlay,
  nodeId: string,
  patch: ArchNodeOverride | null,
): ArchOverlay {
  const overrides = { ...overlay.overrides };
  if (patch === null) {
    delete overrides[nodeId];
    return { ...overlay, overrides };
  }
  const merged = { ...overrides[nodeId], ...patch };
  for (const key of Object.keys(merged) as (keyof ArchNodeOverride)[]) {
    if (merged[key] === undefined) delete merged[key];
  }
  if (Object.keys(merged).length === 0) delete overrides[nodeId];
  else overrides[nodeId] = merged;
  return { ...overlay, overrides };
}

const POSITIONAL_KEYS: ReadonlySet<string> = new Set(["x", "y", "parentId", "size"]);

/** True when an override only moves/resizes — nothing the user authored survives losing the node. */
export function isPositionalOverride(override: ArchNodeOverride): boolean {
  return Object.keys(override).every((k) => POSITIONAL_KEYS.has(k));
}

function applyOverride(node: ArchNode, override: ArchNodeOverride): ArchNode {
  const out: ArchNode = { ...node };
  if (override.x !== undefined && override.y !== undefined)
    out.position = { x: override.x, y: override.y };
  if (override.parentId !== undefined) out.parentId = override.parentId;
  if (override.size !== undefined) out.size = override.size;
  if (override.label !== undefined) out.label = override.label;
  if (override.kind !== undefined) out.kind = override.kind;
  if (override.description !== undefined) out.description = override.description;
  if (override.tech !== undefined) out.tech = override.tech;
  if (override.layer !== undefined) out.layer = override.layer;
  if (override.accent !== undefined) out.accent = override.accent;
  if (override.href !== undefined) out.href = override.href;
  if (override.sim !== undefined) out.sim = override.sim;
  if (override.placements !== undefined)
    out.placements = { ...node.placements, ...override.placements };
  return out;
}

/**
 * The graph every view renders: derived nodes minus hidden subtrees, with
 * overrides applied, manual nodes/edges appended, and the overlay's
 * graph-level state (environments/journeys/facets/viewport) attached.
 * Manual edges with a dangling endpoint are dropped from the composition but
 * kept in the overlay — the endpoint may come back.
 */
export function composeArchitecture(
  derived: ArchitectureGraph,
  overlay: ArchOverlay,
): ArchitectureGraph {
  const hidden = new Set<string>();
  for (const id of overlay.hiddenIds) {
    if (!derived.nodes.some((n) => n.id === id)) continue;
    hidden.add(id);
    for (const d of descendantsOf(derived, id)) hidden.add(d.id);
  }
  const derivedIds = new Set(derived.nodes.map((n) => n.id));
  const nodes = derived.nodes
    .filter((n) => !hidden.has(n.id))
    .map((n) => {
      const override = overlay.overrides[n.id];
      return override ? applyOverride(n, override) : n;
    });
  for (const manual of overlay.manualNodes) {
    if (derivedIds.has(manual.id)) continue;
    const override = overlay.overrides[manual.id];
    nodes.push(override ? applyOverride(manual, override) : manual);
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  const hiddenEdges = new Set(overlay.hiddenEdgeIds);
  const edgeIds = new Set<string>();
  // Manual first — a manual edge sharing a derived id is an edge override.
  const edges = [...overlay.manualEdges, ...derived.edges].filter((e) => {
    if (edgeIds.has(e.id) || hiddenEdges.has(e.id)) return false;
    edgeIds.add(e.id);
    return nodeIds.has(e.source) && nodeIds.has(e.target);
  });
  return {
    ...derived,
    nodes,
    edges,
    environments: overlay.environments,
    journeys: overlay.journeys,
    facets: overlay.facets,
    viewport: overlay.viewport ?? null,
  };
}

export interface OverlayReconciliation {
  overlay: ArchOverlay;
  /**
   * Override ids that no longer resolve to a derived or manual node but carry
   * user-authored content — kept in the overlay (the id may re-derive) and
   * surfaced so the UI can list them as stale customizations.
   */
  staleIds: string[];
}

/**
 * Fold a fresh derivation through the overlay: positional-only overrides and
 * hidden ids whose node vanished are dropped (nothing user-authored is lost),
 * semantic overrides on vanished ids are kept but reported as stale, and
 * facet member ids are left alone (`facetVisibleIds` already ignores
 * dangling members).
 *
 * `extraKnownIds` names ids that exist only above the derivation — the C4
 * tier's aggregates (`ctr:…`, `c4:system`, `person:user`) — so per-level
 * positions and semantic overrides keyed on them survive without reading as
 * stale customizations.
 */
export function reconcileOverlay(
  overlay: ArchOverlay,
  derived: ArchitectureGraph,
  extraKnownIds?: Iterable<string>,
): OverlayReconciliation {
  const known = new Set(derived.nodes.map((n) => n.id));
  for (const manual of overlay.manualNodes) known.add(manual.id);
  for (const id of extraKnownIds ?? []) known.add(id);

  const overrides: Record<string, ArchNodeOverride> = {};
  const staleIds: string[] = [];
  for (const [id, override] of Object.entries(overlay.overrides)) {
    if (known.has(id)) {
      overrides[id] = override;
    } else if (!isPositionalOverride(override)) {
      overrides[id] = override;
      staleIds.push(id);
    }
  }
  const hiddenIds = overlay.hiddenIds.filter((id) => known.has(id));
  const derivedEdgeIds = new Set(derived.edges.map((e) => e.id));
  const hiddenEdgeIds = overlay.hiddenEdgeIds.filter((id) => derivedEdgeIds.has(id));
  // Per-level positions are positional-only by construction — entries whose
  // node vanished from the model drop silently.
  const c4Layouts: ArchOverlay["c4Layouts"] = {};
  for (const [viewKey, positions] of Object.entries(overlay.c4Layouts)) {
    const kept = Object.fromEntries(
      Object.entries(positions).filter(([id]) => known.has(id)),
    );
    if (Object.keys(kept).length > 0) c4Layouts[viewKey] = kept;
  }
  return { overlay: { ...overlay, overrides, hiddenIds, hiddenEdgeIds, c4Layouts }, staleIds };
}

/* ------------------------------------------------------------------ */
/* Canvas edit → overlay                                               */
/* ------------------------------------------------------------------ */

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function overrideFor(
  derivedNode: ArchNode,
  renderedNode: ArchNode | undefined,
  edited: ArchNode,
): ArchNodeOverride | null {
  const o: ArchNodeOverride = {};
  // Position is judged against the *rendered* node — auto-layout owns derived
  // positions, so only an actual drag away from what was shown persists.
  const shown = renderedNode ?? derivedNode;
  if (edited.position.x !== shown.position.x || edited.position.y !== shown.position.y) {
    o.x = edited.position.x;
    o.y = edited.position.y;
  }
  if ((edited.parentId ?? null) !== (derivedNode.parentId ?? null))
    o.parentId = edited.parentId ?? null;
  if (!sameJson(edited.size, shown.size)) o.size = edited.size ?? null;
  if (edited.label !== derivedNode.label) o.label = edited.label;
  if (edited.kind !== derivedNode.kind) o.kind = edited.kind;
  if (edited.description !== derivedNode.description) o.description = edited.description;
  if (!sameJson(edited.tech, derivedNode.tech)) o.tech = edited.tech;
  if ((edited.layer ?? null) !== (derivedNode.layer ?? null)) o.layer = edited.layer ?? null;
  if ((edited.accent ?? null) !== (derivedNode.accent ?? null)) o.accent = edited.accent ?? null;
  if ((edited.href ?? null) !== (derivedNode.href ?? null)) o.href = edited.href ?? null;
  if (!sameJson(edited.sim, derivedNode.sim)) o.sim = edited.sim ?? null;
  if (!sameJson(edited.placements, derivedNode.placements)) o.placements = edited.placements;
  return Object.keys(o).length > 0 ? o : null;
}

/**
 * Translate a canvas edit back into the overlay: the views keep operating on
 * a plain `ArchitectureGraph` (`edited`), and persistence extracts what the
 * user actually authored by diffing against the derivation (`derived`) and
 * against what was on screen (`rendered` — the composed graph post-layout,
 * so auto-layout positions never persist as overrides).
 *
 * `prev` carries forward stale semantic overrides on vanished ids (the
 * reconcile contract) — everything else is recomputed from the edit.
 */
export function extractOverlay(args: {
  derived: ArchitectureGraph;
  rendered: ArchitectureGraph;
  edited: ArchitectureGraph;
  prev: ArchOverlay;
}): ArchOverlay {
  const { derived, rendered, edited, prev } = args;
  const derivedById = new Map(derived.nodes.map((n) => [n.id, n]));
  const renderedById = new Map(rendered.nodes.map((n) => [n.id, n]));
  const editedIds = new Set(edited.nodes.map((n) => n.id));

  const overrides: Record<string, ArchNodeOverride> = {};
  const manualNodes: ArchNode[] = [];
  for (const node of edited.nodes) {
    const derivedNode = derivedById.get(node.id);
    if (!derivedNode) {
      manualNodes.push(node);
      // A manual node's position is user-authored the moment it is placed or
      // dragged — record it as an x/y override so the renderer pins it
      // (auto-layout owns everything without one). Migrated manual nodes
      // start unpinned; their first drag lands here.
      const shown = renderedById.get(node.id);
      if (!shown || shown.position.x !== node.position.x || shown.position.y !== node.position.y) {
        overrides[node.id] = { ...overrides[node.id], x: node.position.x, y: node.position.y };
      } else if (prev.overrides[node.id]?.x != null) {
        // already pinned and unmoved — keep the pin
        const p = prev.overrides[node.id]!;
        overrides[node.id] = { ...overrides[node.id], x: p.x, y: p.y };
      }
      continue;
    }
    const o = overrideFor(derivedNode, renderedById.get(node.id), node);
    if (o) overrides[node.id] = o;
  }
  // Stale semantic customizations on ids that no longer derive survive the
  // round trip — the id may come back (see reconcileOverlay).
  const manualIds = new Set(manualNodes.map((n) => n.id));
  for (const [id, o] of Object.entries(prev.overrides)) {
    if (!derivedById.has(id) && !manualIds.has(id) && !isPositionalOverride(o)) overrides[id] = o;
  }

  const derivedEdgeById = new Map(derived.edges.map((e) => [e.id, e]));
  const editedEdgeIds = new Set(edited.edges.map((e) => e.id));
  const manualEdges = edited.edges.filter((e) => {
    const d = derivedEdgeById.get(e.id);
    return !d || d.kind !== e.kind || d.label !== e.label;
  });

  const hiddenIds = derived.nodes
    .filter((n) => !editedIds.has(n.id))
    .map((n) => n.id)
    // A hidden container already hides its subtree in the composition —
    // keeping only subtree roots keeps the list minimal and un-hiding sane.
    .filter((id, _i, all) => {
      let cur = derivedById.get(id)?.parentId ?? null;
      while (cur) {
        if (all.includes(cur)) return false;
        cur = derivedById.get(cur)?.parentId ?? null;
      }
      return true;
    });

  const hiddenEdgeIds = derived.edges
    .filter(
      (e) =>
        !editedEdgeIds.has(e.id) &&
        // an edge whose endpoint went hidden/vanished is dropped by
        // composition anyway — only record deliberate edge deletions
        editedIds.has(e.source) &&
        editedIds.has(e.target),
    )
    .map((e) => e.id);

  return {
    overrides,
    manualNodes,
    manualEdges,
    hiddenIds,
    hiddenEdgeIds,
    environments: edited.environments,
    journeys: edited.journeys,
    facets: edited.facets,
    viewport: edited.viewport ?? prev.viewport ?? null,
    // Per-level C4 positions are edited by the C4 canvas directly
    // (`setC4Position`) — a full-graph extraction never touches them.
    c4Layouts: prev.c4Layouts,
  };
}

/**
 * Pin (or unpin, `position: null`) one node's manual position at one C4 view.
 * The C4 canvas's drag-commit path — everything else about a C4 edit goes
 * through targeted overlay ops on canonical ids.
 */
export function setC4Position(
  overlay: ArchOverlay,
  viewKey: string,
  nodeId: string,
  position: { x: number; y: number } | null,
): ArchOverlay {
  const level = { ...overlay.c4Layouts[viewKey] };
  if (position) level[nodeId] = position;
  else delete level[nodeId];
  const c4Layouts = { ...overlay.c4Layouts };
  if (Object.keys(level).length > 0) c4Layouts[viewKey] = level;
  else delete c4Layouts[viewKey];
  return { ...overlay, c4Layouts };
}

/**
 * Remove every manual pin at one C4 altitude.
 *
 * Auto-layout is a per-view reset: deleting the level in one operation keeps
 * pins at the other C4 altitudes intact. Preserve identity when the level is
 * already absent so a no-op toolbar click does not cause an overlay write or
 * restart layout work downstream.
 */
export function clearC4Layout(overlay: ArchOverlay, viewKey: string): ArchOverlay {
  if (overlay.c4Layouts[viewKey] == null) return overlay;
  const c4Layouts = { ...overlay.c4Layouts };
  delete c4Layouts[viewKey];
  return { ...overlay, c4Layouts };
}
