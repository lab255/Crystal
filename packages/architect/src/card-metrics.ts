import { isContainerKind, type ArchNode, type ArchitectureGraph } from "@crystal/core";

export interface CardSizeOptions {
  /** C4 type text changes the label, but remains a single rendered line. */
  c4Type?: string | undefined;
  /** Whether the linked-code badge is visible. Defaults to the presence of `codeModule`. */
  codeBadge?: boolean;
}

const ENTITY_WIDTH = 180;
const ENTITY_HEIGHT = 90;
const PERSON_WIDTH = 120;
const C4_CARD_WIDTH = 288; // max-w-72
const LEAF_CARD_WIDTH = 224; // max-w-56
const CARD_PADDING_X = 24; // px-3
const CARD_PADDING_Y = 16; // py-2
const CHIP_GAP = 4; // gap-1

/**
 * The renderer treats a system/group as a pen only once it has contents or
 * an explicit canvas size. A bare system is a leaf card (not a tiny empty
 * compound), which is particularly important at the C4 context level.
 */
export function rendersAsPen(node: ArchNode, hasChildren: boolean): boolean {
  return isContainerKind(node.kind) && (hasChildren || node.size != null);
}

/** Number of Badge rows produced by the leaf renderer's four-chip preview. */
function chipRowCount(labels: readonly string[], innerWidth: number): number {
  if (labels.length === 0) return 0;
  const visible = labels.slice(0, 4);
  if (labels.length > 4) visible.push(`+${labels.length - 4}`);

  let rows = 1;
  let rowWidth = 0;
  for (const label of visible) {
    // Badge text is roughly 7px per character at this tier, plus its inline
    // padding. Including the flex gap here mirrors browser wrapping.
    const width = 7 * label.length + 14;
    const nextWidth = rowWidth === 0 ? width : rowWidth + CHIP_GAP + width;
    if (rowWidth > 0 && nextWidth > innerWidth) {
      rows += 1;
      rowWidth = width;
    } else {
      rowWidth = nextWidth;
    }
  }
  return rows;
}

/**
 * Deterministic approximation of `LeafNode`'s browser footprint.
 *
 * The layout runs before React has necessarily measured every card, so it
 * needs a stable first-pass size. These constants intentionally follow the
 * Tailwind structure in the renderer rather than text-measuring with a DOM:
 * that keeps layout worker-safe, reproducible, and close enough that a later
 * measured `dims` map can be authoritative without changing the algorithm.
 */
export function estimateCardSize(
  node: ArchNode,
  opts: CardSizeOptions = {},
): { width: number; height: number } {
  if (node.kind === "entity") return { width: ENTITY_WIDTH, height: ENTITY_HEIGHT };

  if (node.kind === "person") {
    // Outer py-2, the silhouette's pt-1, avatar, tiny flex gap, label, and
    // type line. Descriptions are line-clamped to two lines; the final clamp
    // reflects the compact card's measured browser range.
    const descriptionHeight = node.description ? 4 + 2 * 14.3 : 0;
    const height = CARD_PADDING_Y + 4 + 32 + 2 + 16 + 2 + 14 + descriptionHeight;
    return { width: PERSON_WIDTH, height: Math.ceil(Math.min(110, Math.max(64, height))) };
  }

  const width =
    node.kind === "container" || node.kind === "system" ? C4_CARD_WIDTH : LEAF_CARD_WIDTH;
  let height = CARD_PADDING_Y + 18 + 14;

  if (node.description) height += 4 + 2 * 14.3;

  const chipRows = chipRowCount(node.tech, width - CARD_PADDING_X);
  if (chipRows > 0) height += chipRows * 24 + 6;

  // `c4Type` is accepted because callers know whether the bracketed type is
  // present, although both variants occupy the same single line today.
  void opts.c4Type;
  if (opts.codeBadge ?? (node.codeModule != null)) height += 22;

  return { width, height: Math.max(56, Math.ceil(height)) };
}

/**
 * Estimated dimensions for every node that React renders as a card. Pens are
 * deliberately absent: ELK owns their fitted size from their child extents.
 */
export function estimateGraphDims(
  graph: ArchitectureGraph,
  opts: { c4TypeOf?: (id: string) => string | undefined } = {},
): Map<string, { width: number; height: number }> {
  const parents = new Set(
    graph.nodes.map((node) => node.parentId).filter((id): id is string => id != null),
  );
  const dims = new Map<string, { width: number; height: number }>();
  for (const node of graph.nodes) {
    if (rendersAsPen(node, parents.has(node.id))) continue;
    dims.set(node.id, estimateCardSize(node, { c4Type: opts.c4TypeOf?.(node.id) }));
  }
  return dims;
}
