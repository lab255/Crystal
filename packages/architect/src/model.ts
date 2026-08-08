import type { Edge as RfEdge, Node as RfNode } from "@xyflow/react";
import { MarkerType } from "@xyflow/react";
import {
  isContainerKind,
  topoOrderNodes,
  type ArchEdge,
  type ArchEdgeKind,
  type ArchNode,
  type ArchNodeKind,
  type ArchitectureGraph,
  type DiffMark,
  type DiffMarks,
  type HighlightRef,
} from "@crystal/core";
import {
  AppWindow,
  Boxes,
  Container,
  Database,
  Folder,
  GitBranch,
  Globe,
  Network,
  Package,
  Rows3,
  Server,
  StickyNote,
  Table2,
  UserRound,
  Waypoints,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { OverlayBadge } from "./overlay.js";
import type { SystemCardFacts } from "./system-card.js";
import { assignLanes, isBusbarScale } from "./edge-routing.js";

/* ------------------------------------------------------------------ */
/* Presentation metadata per node kind                                 */
/* ------------------------------------------------------------------ */

export type AccentName = NonNullable<ArchNode["accent"]>;

export interface KindMeta {
  label: string;
  icon: LucideIcon;
  defaultAccent: AccentName;
}

export const KIND_META: Record<ArchNodeKind, KindMeta> = {
  system: { label: "System", icon: Boxes, defaultAccent: "violet" },
  group: { label: "Group", icon: Folder, defaultAccent: "slate" },
  service: { label: "Service", icon: Server, defaultAccent: "violet" },
  repo: { label: "Repository", icon: GitBranch, defaultAccent: "slate" },
  package: { label: "Package", icon: Package, defaultAccent: "violet" },
  datastore: { label: "Datastore", icon: Database, defaultAccent: "emerald" },
  cache: { label: "Cache", icon: Zap, defaultAccent: "rose" },
  queue: { label: "Queue", icon: Rows3, defaultAccent: "amber" },
  gateway: { label: "Gateway", icon: Network, defaultAccent: "blue" },
  loadbalancer: { label: "Load balancer", icon: Waypoints, defaultAccent: "cyan" },
  frontend: { label: "Frontend", icon: AppWindow, defaultAccent: "cyan" },
  external: { label: "External", icon: Globe, defaultAccent: "slate" },
  endpoint: { label: "Endpoint", icon: Waypoints, defaultAccent: "blue" },
  note: { label: "Note", icon: StickyNote, defaultAccent: "amber" },
  person: { label: "Person", icon: UserRound, defaultAccent: "blue" },
  container: { label: "Container", icon: Container, defaultAccent: "cyan" },
  entity: { label: "Entity", icon: Table2, defaultAccent: "emerald" },
};

export const ACCENT_CSS: Record<AccentName, string> = {
  violet: "var(--color-accent-violet)",
  cyan: "var(--color-accent-cyan)",
  emerald: "var(--color-accent-emerald)",
  amber: "var(--color-accent-amber)",
  rose: "var(--color-accent-rose)",
  blue: "var(--color-accent-blue)",
  slate: "var(--color-accent-slate)",
};

export function accentOf(node: ArchNode): string {
  return ACCENT_CSS[node.accent ?? KIND_META[node.kind].defaultAccent];
}

/* ------------------------------------------------------------------ */
/* Core graph ⇄ react-flow conversion                                  */
/* ------------------------------------------------------------------ */

/** Journey lens decoration: hop number reaching this node, or null = dimmed. */
export interface FlowMark {
  step: number | null;
}

export type ArchRfNode = RfNode<{
  arch: ArchNode;
  code?: OverlayBadge;
  flow?: FlowMark;
  /**
   * Card slot: system cards render at the size their semantic body needs
   * (see `systemCardSlot`), so the body always fits without clipping.
   */
  slot?: { width: number; height: number };
  /**
   * Semantic system-card body (exports with consumer counts, consumes
   * footer, role) joined from the overview by canonical id — a plain,
   * structured-clonable record (see system-card.ts).
   */
  system?: SystemCardFacts;
  /** Node is expanded into live code (unified view) — renders as a container. */
  codeExpanded?: boolean;
  /** Expanded, but the module detail is still loading. */
  codeLoading?: boolean;
  /** Node is opened into its part tier — renders as a container. */
  partsExpanded?: boolean;
  /**
   * Structured cross-view identity (node id, containment chain, code links)
   * stamped onto the DOM as data attributes — see use-highlight.ts.
   */
  hlRef?: HighlightRef;
  /** Ref-review mark (vs <ref>) — added/removed/changed tint, ghost render. */
  diff?: DiffMark;
  /**
   * C4 element type line from the active projection ("Container · Web
   * application") — rendered bracketed under the label, C4-notation style.
   * Absent outside the C4 architecture view.
   */
  c4Type?: string;
}>;
export type ArchRfEdge = RfEdge<{ kind: ArchEdgeKind; lane?: number }>;

/** Shared diff tinting for the architecture views (matches the codebase map). */
export const DIFF_EDGE_STROKE: Record<DiffMark["kind"], string> = {
  added: "var(--color-ok)",
  removed: "var(--color-danger)",
  changed: "var(--color-warn)",
};

export function rfTypeFor(kind: ArchNodeKind): string {
  if (isContainerKind(kind)) return "container";
  if (kind === "note") return "note";
  return "leaf";
}

export function toRfNodes(
  graph: ArchitectureGraph,
  selectedIds: ReadonlySet<string>,
  slots?: ReadonlyMap<string, { width: number; height: number }>,
  marks?: DiffMarks | null,
): ArchRfNode[] {
  const childCount = new Map<string, number>();
  for (const n of graph.nodes) {
    if (n.parentId) childCount.set(n.parentId, (childCount.get(n.parentId) ?? 0) + 1);
  }
  return topoOrderNodes(graph).map((n) => {
    // A container kind with neither children nor an explicit size renders as
    // a card, not an empty pen — the C4 context level's one-box system.
    const container =
      isContainerKind(n.kind) && ((childCount.get(n.id) ?? 0) > 0 || n.size != null);
    const mark = marks?.[n.id];
    const node: ArchRfNode = {
      id: n.id,
      type: container ? "container" : n.kind === "note" ? "note" : "leaf",
      position: { ...n.position },
      data: { arch: n, ...(mark ? { diff: mark } : {}) },
      selected: selectedIds.has(n.id),
      // Ghosts exist only at the review base — inert on the canvas.
      ...(mark?.ghost ? { draggable: false, connectable: false } : {}),
      dragHandle: container ? ".arch-container-header" : undefined,
    };
    if (n.parentId) node.parentId = n.parentId;
    if (container) {
      node.width = n.size?.width ?? 420;
      node.height = n.size?.height ?? 280;
      node.zIndex = -1;
    } else {
      const slot = slots?.get(n.id);
      if (slot) {
        node.width = slot.width;
        node.height = slot.height;
        node.data.slot = slot;
      }
    }
    return node;
  });
}

export const EDGE_KIND_STYLE: Record<
  ArchEdgeKind,
  { stroke: string; dash?: string; label: string }
> = {
  sync: { stroke: "var(--color-accent-blue)", label: "Sync call" },
  async: { stroke: "var(--color-accent-amber)", dash: "6 4", label: "Async / events" },
  data: { stroke: "var(--color-accent-emerald)", dash: "2 3", label: "Data flow" },
  dependency: { stroke: "var(--color-accent-slate)", label: "Dependency" },
};

export function toRfEdges(
  graph: ArchitectureGraph,
  selectedIds: ReadonlySet<string>,
  marks?: DiffMarks | null,
): ArchRfEdge[] {
  // Small diagrams read best with curves; past the threshold, orthogonal
  // bus-bar routing keeps the dependency web sorted and legible.
  const busbar = isBusbarScale(graph.edges.length);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const absX = (id: string): number => {
    let x = 0;
    let cur = byId.get(id);
    while (cur) {
      x += cur.position.x;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return x;
  };
  const lanes = busbar ? assignLanes(graph.edges, absX) : null;
  // Traffic-proportional strokes (the systems view's reading): sqrt keeps a
  // 100× edge readable next to a 1× one without drowning the canvas.
  const maxWeight = Math.max(1, ...graph.edges.map((e) => e.weight ?? 0));
  return graph.edges.map((e) => {
    const style = EDGE_KIND_STYLE[e.kind];
    const mark = marks?.[e.id];
    // Priority: diff marks (a review is an explicit question) over the cycle
    // warning over the kind palette.
    const stroke = mark
      ? DIFF_EDGE_STROKE[mark.kind]
      : e.cycle
        ? "var(--color-warn)"
        : style.stroke;
    const weightWidth =
      e.weight != null && e.weight > 0
        ? 1 + 1.6 * Math.sqrt(e.weight / maxWeight)
        : 1.5;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: mark?.detail ?? (e.label || undefined),
      selected: selectedIds.has(e.id),
      data: { kind: e.kind, lane: lanes?.get(e.id) ?? 0 },
      type: busbar ? "busbar" : "default",
      style: {
        stroke,
        strokeWidth: mark ? 2 : weightWidth,
        // Api-only boundaries dash: a wire contract, not a compile-time dep.
        strokeDasharray: mark?.ghost ? "6 4" : e.apiOnly ? "5 4" : style.dash,
        opacity: mark?.ghost ? 0.55 : 0.9,
      },
      labelStyle: {
        fill: mark ? stroke : e.cycle ? stroke : "var(--color-ink-muted)",
        fontSize: 10,
      },
      labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 16, height: 16 },
    };
  });
}

/** Write RF node geometry (positions, sizes, parents) back onto a core graph. */
export function applyRfGeometry(graph: ArchitectureGraph, rfNodes: ArchRfNode[]): ArchitectureGraph {
  const byId = new Map(rfNodes.map((n) => [n.id, n]));
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const rf = byId.get(n.id);
      if (!rf) return n;
      const next: ArchNode = {
        ...n,
        position: { x: rf.position.x, y: rf.position.y },
        parentId: rf.parentId ?? null,
      };
      if (isContainerKind(n.kind) && rf.width != null && rf.height != null) {
        next.size = { width: rf.width, height: rf.height };
      }
      return next;
    }),
  };
}

export function edgeIdsBetween(graph: ArchitectureGraph, nodeIds: Set<string>): string[] {
  return graph.edges
    .filter((e) => nodeIds.has(e.source) || nodeIds.has(e.target))
    .map((e) => e.id);
}
