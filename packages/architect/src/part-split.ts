import dagre from "@dagrejs/dagre";
import { MarkerType, type Edge as RfEdge, type Node as RfNode } from "@xyflow/react";
import {
  canonicalSystemIds,
  type SystemLink,
  type SystemModule,
  type SystemOverview,
  type SystemPart,
} from "@crystal/core";

/**
 * The part tier of an expanded system: a multi-part system opens into a
 * container holding one card per `SystemPart`, wired by the intra-system
 * `partLinks`, while its boundary `link:` edges split along the
 * `SystemLink.parts` attribution (`part→part` instead of `system→system`).
 * Ported from the retired systems view; the ids and semantics are the same:
 *
 *  - only multi-part systems open — a single part IS the card itself;
 *  - api-only links never split (an HTTP contract has no import attribution);
 *  - several part pairs re-aggregate onto one visible edge when only one
 *    side is expanded; split ids are `<aggregateId>#<i>` so a `link:` prefix
 *    check still matches and the contract lookup can strip the suffix.
 */

export const PART_W = 190;
export const PART_H = 46;
const GROUP_HEADER_H = 40;
const GROUP_PAD = 14;
/** Never shrink an opened system below the collapsed card width. */
const MIN_OPEN_W = 252;

/** Stable node id of one part inside an expanded system (ephemeral, never persisted). */
export const partNodeId = (sysId: string, partPath: string): string =>
  `part:${sysId}|${partPath}`;

export interface PartNodeData {
  sysId: string;
  part: SystemPart;
  [key: string]: unknown;
}
export type PartRfNode = RfNode<PartNodeData>;

export interface PartsContent {
  /** Part cards, parent-relative under their system container. */
  nodes: PartRfNode[];
  /** Container size each expanded system needs. */
  sizes: Map<string, { width: number; height: number }>;
  /** Intra-system part wiring (`partLinks`). */
  edges: RfEdge[];
}

const EMPTY_CONTENT: PartsContent = { nodes: [], sizes: new Map(), edges: [] };

/** Canonical node id → system, for systems that can open (more than one part). */
export function multiPartSystems(overview: SystemOverview): Map<string, SystemModule> {
  const idOf = canonicalSystemIds(overview.systems);
  const m = new Map<string, SystemModule>();
  for (const s of overview.systems) {
    if (s.parts.length > 1) m.set(idOf.get(s.id) ?? s.id, s);
  }
  return m;
}

/**
 * Inner layout of an expanded system: dagre (LR) over its parts wired by the
 * intra-system part links — container-relative positions, headroom for the
 * container header.
 */
function expandLayout(system: SystemModule): {
  width: number;
  height: number;
  children: { part: SystemPart; x: number; y: number }[];
} {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 16, ranksep: 46, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const p of system.parts) g.setNode(p.path, { width: PART_W, height: PART_H });
  for (const l of system.partLinks ?? []) {
    if (l.source !== l.target) g.setEdge(l.source, l.target);
  }
  dagre.layout(g);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const raw = system.parts.map((part) => {
    const pos = g.node(part.path);
    const x = pos.x - PART_W / 2;
    const y = pos.y - PART_H / 2;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + PART_W);
    maxY = Math.max(maxY, y + PART_H);
    return { part, x, y };
  });
  return {
    width: Math.max(maxX - minX + GROUP_PAD * 2, MIN_OPEN_W),
    height: maxY - minY + GROUP_HEADER_H + GROUP_PAD,
    children: raw.map((c) => ({
      part: c.part,
      x: c.x - minX + GROUP_PAD,
      y: c.y - minY + GROUP_HEADER_H,
    })),
  };
}

export function buildPartsContent(
  expanded: ReadonlySet<string>,
  systemOf: ReadonlyMap<string, SystemModule> | null,
): PartsContent {
  if (!systemOf || expanded.size === 0) return EMPTY_CONTENT;
  const nodes: PartRfNode[] = [];
  const sizes = new Map<string, { width: number; height: number }>();
  const edges: RfEdge[] = [];
  for (const sysId of expanded) {
    const system = systemOf.get(sysId);
    if (!system) continue;
    const inner = expandLayout(system);
    sizes.set(sysId, { width: inner.width, height: inner.height });
    for (const c of inner.children) {
      nodes.push({
        id: partNodeId(sysId, c.part.path),
        type: "part",
        parentId: sysId,
        position: { x: c.x, y: c.y },
        width: PART_W,
        height: PART_H,
        draggable: false,
        data: { sysId, part: c.part },
      });
    }
    for (const pl of system.partLinks ?? []) {
      edges.push({
        id: `intra#${sysId}#${pl.source}->${pl.target}`,
        source: partNodeId(sysId, pl.source),
        target: partNodeId(sysId, pl.target),
        selectable: false,
        deletable: false,
        data: { kind: "dependency" },
        zIndex: 1,
        label: `×${pl.weight}`,
        labelStyle: { fontSize: 8, fill: "var(--color-ink-faint)" },
        labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.85 },
        style: { stroke: "var(--color-edge-strong)", strokeWidth: 1, opacity: 0.9 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
      });
    }
  }
  return { nodes, sizes, edges };
}

/**
 * Split boundary edges along their part attribution. Operates on the already
 * styled rf edges: a split inherits the aggregate's styling (kind, diff tint,
 * dash) and re-derives only what the split changes — endpoints, weight label
 * and traffic-proportional stroke. Identity-preserving for untouched edges.
 */
export function splitEdgesByParts<E extends RfEdge>(
  edges: E[],
  opts: {
    expanded: ReadonlySet<string>;
    /** Canonical `link:` edge id → its overview link (see `linkByEdgeId`). */
    linkOf: ReadonlyMap<string, SystemLink>;
    /** Same normalization as `toRfEdges` so strokes don't jump on expand. */
    maxWeight: number;
  },
): E[] {
  const { expanded, linkOf, maxWeight } = opts;
  if (expanded.size === 0) return edges;
  let changed = false;
  const out: E[] = [];
  for (const e of edges) {
    const link = linkOf.get(e.id);
    const apiOnly = link != null && link.weight === 0 && (link.apis?.length ?? 0) > 0;
    const splits =
      link &&
      !apiOnly &&
      link.parts &&
      link.parts.length > 0 &&
      (expanded.has(e.source) || expanded.has(e.target))
        ? [
            ...link.parts
              .reduce((agg, p) => {
                const source = expanded.has(e.source)
                  ? partNodeId(e.source, p.sourcePart)
                  : e.source;
                const target = expanded.has(e.target)
                  ? partNodeId(e.target, p.targetPart)
                  : e.target;
                const k = `${source}->${target}`;
                const entry = agg.get(k) ?? { source, target, weight: 0 };
                entry.weight += p.weight;
                return agg.set(k, entry);
              }, new Map<string, { source: string; target: string; weight: number }>())
              .values(),
          ]
        : null;
    if (!splits) {
      out.push(e);
      continue;
    }
    changed = true;
    splits.forEach((sp, i) => {
      out.push({
        ...e,
        id: `${e.id}#${i}`,
        source: sp.source,
        target: sp.target,
        label: `×${sp.weight}`,
        zIndex: 1,
        style: {
          ...e.style,
          strokeWidth: 1 + 1.6 * Math.sqrt(sp.weight / Math.max(1, maxWeight)),
        },
      });
    });
  }
  return changed ? out : edges;
}
