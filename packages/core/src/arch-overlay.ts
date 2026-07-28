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
  /** User-drawn edges (between any mix of derived and manual nodes). */
  manualEdges: z.array(ArchEdgeSchema).default([]),
  /** Derived node ids the user removed from the diagram (subtree-inclusive). */
  hiddenIds: z.array(z.string()).default([]),
  /** Workspace-scoped environments (previously per-diagram). */
  environments: z.array(ArchEnvironmentSchema).default([]),
  journeys: z.array(JourneySchema).default([]),
  facets: z.array(ArchFacetSchema).default([]),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).nullish(),
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
  const edgeIds = new Set<string>();
  const edges = [...derived.edges, ...overlay.manualEdges].filter((e) => {
    if (edgeIds.has(e.id)) return false;
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
 */
export function reconcileOverlay(
  overlay: ArchOverlay,
  derived: ArchitectureGraph,
): OverlayReconciliation {
  const known = new Set(derived.nodes.map((n) => n.id));
  for (const manual of overlay.manualNodes) known.add(manual.id);

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
  return { overlay: { ...overlay, overrides, hiddenIds }, staleIds };
}
