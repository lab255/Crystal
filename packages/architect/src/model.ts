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
  type HighlightRef,
} from "@crystal/core";
import {
  AppWindow,
  Boxes,
  Database,
  Folder,
  GitBranch,
  Globe,
  Network,
  Package,
  Rows3,
  Server,
  StickyNote,
  Waypoints,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { OverlayBadge } from "./overlay.js";
import type { BlockPreview } from "./live-code.js";
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
  note: { label: "Note", icon: StickyNote, defaultAccent: "amber" },
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
   * Reserved level-of-detail footprint: the node renders collapsed at the
   * exact size its live-code expansion will occupy, so detail arriving with
   * zoom fills a box that never moves or grows.
   */
  slot?: { width: number; height: number };
  /**
   * Collapsed-block content preview (top files of the linked module) — shown
   * inside the slot at medium zoom, where a bare title wastes the reserved area.
   */
  preview?: BlockPreview;
  /** Node is expanded into live code (unified view) — renders as a container. */
  codeExpanded?: boolean;
  /** Expanded, but the module detail is still loading. */
  codeLoading?: boolean;
  /**
   * Structured cross-view identity (node id, containment chain, code links)
   * stamped onto the DOM as data attributes — see use-highlight.ts.
   */
  hlRef?: HighlightRef;
}>;
export type ArchRfEdge = RfEdge<{ kind: ArchEdgeKind; lane?: number }>;

export function rfTypeFor(kind: ArchNodeKind): string {
  if (isContainerKind(kind)) return "container";
  if (kind === "note") return "note";
  return "leaf";
}

export function toRfNodes(
  graph: ArchitectureGraph,
  selectedIds: ReadonlySet<string>,
  slots?: ReadonlyMap<string, { width: number; height: number }>,
): ArchRfNode[] {
  return topoOrderNodes(graph).map((n) => {
    const container = isContainerKind(n.kind);
    const node: ArchRfNode = {
      id: n.id,
      type: rfTypeFor(n.kind),
      position: { ...n.position },
      data: { arch: n },
      selected: selectedIds.has(n.id),
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
  return graph.edges.map((e) => {
    const style = EDGE_KIND_STYLE[e.kind];
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label || undefined,
      selected: selectedIds.has(e.id),
      data: { kind: e.kind, lane: lanes?.get(e.id) ?? 0 },
      type: busbar ? "busbar" : "default",
      style: {
        stroke: style.stroke,
        strokeWidth: 1.5,
        strokeDasharray: style.dash,
        opacity: 0.9,
      },
      labelStyle: { fill: "var(--color-ink-muted)", fontSize: 10 },
      labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke, width: 16, height: 16 },
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
