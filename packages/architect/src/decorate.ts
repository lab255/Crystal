import { MarkerType, type Edge as RfEdge } from "@xyflow/react";
import { matchHighlight, type HighlightRef } from "@crystal/core";
import { cn } from "@crystal/ui";
import { hlClass } from "./use-highlight.js";
import type { MapNodeData } from "./codemap/map-model.js";

export const HOVER_OUT_STROKE = "var(--color-accent-cyan)";
export const HOVER_IN_STROKE = "var(--color-accent-emerald)";

/**
 * The per-interaction decorations of the architecture canvas — hover
 * spotlight, find dimming, selection flash, cross-view highlight rings.
 *
 * These change on every mouse dwell, so they are applied as a separate,
 * identity-preserving pass AFTER the structural node build: a node that gains
 * no decoration is returned as the same object (its `data` is never touched),
 * so `React.memo` on the card components holds and a hover re-renders only
 * the handful of nodes whose classes actually changed — not the whole canvas.
 */
export interface CanvasDecor {
  /** Nodes dimmed by the global find box (misses), or null when no query. */
  findMisses: ReadonlySet<string> | null;
  /** One-shot attention flash (reveal-on-diagram). */
  flashId: string | null;
  /** Node id under the cursor after the hover dwell. */
  hovered: string | null;
  /** The hovered node plus everything it connects to; null when not hovering. */
  hoverNeighborhood: ReadonlySet<string> | null;
  /** Hover published by another surface (flamegraph, journey, code map). */
  externalHover: HighlightRef | null;
  /** Deep-linked pinned highlight (`sel`). */
  pinned: HighlightRef | null;
}

interface DecorNode {
  id: string;
  parentId?: string;
  className?: string;
  data: unknown;
}

/**
 * Apply `decor` to structural nodes as className additions only. Nodes whose
 * decoration set is empty keep their exact object identity; when nothing in
 * the array changes, the input array itself is returned.
 */
export function decorateNodes<N extends DecorNode>(
  nodes: N[],
  decor: CanvasDecor,
  /** Cross-view identity of a live-code child (its data lacks `hlRef`). */
  hlRefForChild: (data: Partial<MapNodeData>) => HighlightRef | null,
): N[] {
  const { findMisses, flashId, hovered, hoverNeighborhood, externalHover, pinned } = decor;
  const active =
    (findMisses != null && findMisses.size > 0) ||
    flashId != null ||
    hoverNeighborhood != null ||
    externalHover != null ||
    pinned != null;
  if (!active) return nodes;

  // Spotlight the hovered node's import/export neighborhood by lifting it,
  // not by receding everything else: the node under the cursor gets the
  // strongest emphasis, its connected kin a softer one, and the rest of the
  // diagram stays exactly as it was. Containers light when a child does.
  let lit: ((id: string) => boolean) | null = null;
  if (hoverNeighborhood) {
    const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]));
    lit = (id: string): boolean => {
      let cur: string | undefined = id;
      while (cur) {
        if (hoverNeighborhood.has(cur)) return true;
        cur = parentOf.get(cur) ?? undefined;
      }
      return false;
    };
  }

  let changed = false;
  const out = nodes.map((n) => {
    const classes: string[] = [];
    // Live-code children ride their module's find verdict (generated ids).
    if (findMisses && (findMisses.has(n.id) || (n.parentId && findMisses.has(n.parentId))))
      classes.push("arch-find-miss");
    if (flashId && n.id === flashId) classes.push("arch-flash");
    if (lit && lit(n.id)) classes.push(n.id === hovered ? "arch-hover-focus" : "arch-hover-near");
    if (externalHover || pinned) {
      // Ring whatever matches the hover published by another surface or the
      // deep-linked pinned selection. Kin = same lineage, softer ring.
      const el =
        (n.data as { hlRef?: HighlightRef }).hlRef ??
        hlRefForChild(n.data as Partial<MapNodeData>);
      if (el) {
        const cls = hlClass(matchHighlight(externalHover, el), matchHighlight(pinned, el));
        if (cls) classes.push(cls);
      }
    }
    if (classes.length === 0) return n;
    changed = true;
    return { ...n, className: cn(n.className, ...classes) };
  });
  return changed ? out : nodes;
}

/**
 * Hover styling for edges, same identity-preserving contract. Direction is
 * the information: cyan = the hovered node imports/uses this, emerald = this
 * imports/uses the hovered node.
 */
export function decorateEdges<E extends RfEdge>(edges: E[], hovered: string | null): E[] {
  if (!hovered) return edges;
  let changed = false;
  const out = edges.map((e) => {
    if (e.source !== hovered && e.target !== hovered) return e;
    changed = true;
    const color = e.source === hovered ? HOVER_OUT_STROKE : HOVER_IN_STROKE;
    return {
      ...e,
      style: { ...e.style, stroke: color, strokeDasharray: undefined, strokeWidth: 2.2, opacity: 1 },
      labelStyle: { fill: color, fontSize: 10, fontWeight: 600 },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      zIndex: 5,
    };
  });
  return changed ? out : edges;
}
