import { MarkerType, type Edge as RfEdge } from "@xyflow/react";
import type { CodeFileSummary, CodeModuleDetail, MoveFileIntent } from "@crystal/core";
import {
  FILE_COLLAPSED_H,
  FILE_COLLAPSED_W,
  GAP,
  MODULE_INNER_MAX_W,
  MODULE_PAD,
  accentFor,
  buildFile,
  fileId,
  packGrid,
  type BuiltFile,
  type DropTarget,
  type FileBuildInput,
  type FileNodeData,
  type MapRfNode,
  type MoveLikeIntent,
  type PositionedNode,
  absolutePositionOf,
} from "./codemap/map-model.js";
import { moduleFlavorOf, roleOfFile, roleRank } from "./code-roles.js";

/**
 * Live code content for the unified diagram canvas: an expanded, code-linked
 * diagram node renders its module's files (and their symbols, and their
 * source) as ephemeral react-flow children. Everything here is derived view
 * state — nothing is written to the architecture graph, so expanding is pure
 * zoom, not an edit.
 *
 * Detail is summarized, not exhaustive: a module shows only its most connected
 * files (a "+N more" chip reveals the rest), files being refactored always
 * stay visible, and dense modules draw only the import edges that matter to
 * the refactor at hand. Fully expanded must stay readable — that is the state
 * you refactor in.
 */

/** Vertical room for the diagram container's header above the file grid. */
export const ARCH_CODE_HEADER_H = 44;
/** Container size while the module detail is still loading. */
export const CODE_LOADING_SIZE = { width: 260, height: 96 };
/** File cards per expanded module before the "+N more files" chip. */
export const LIVE_FILE_CAP = 14;
/** Modules showing more files than this draw only refactor-relevant import edges. */
export const EDGE_FULL_LIMIT = 10;
/** Geometry of the "+N more files" chip. */
export const OVERFLOW_CHIP_H = 30;

export interface CodeContentInput extends FileBuildInput {
  /** Diagram node id → module path expanded into live code. */
  expanded: ReadonlyMap<string, string>;
  moduleDetails: ReadonlyMap<string, CodeModuleDetail>;
  /** Move intents on the active draft — rendered as ghosts/marks. */
  moves: readonly MoveLikeIntent[];
  /** Diagram node ids showing every file despite the cap. */
  showAllFiles?: ReadonlySet<string>;
}

export interface CodeContent {
  /** File cards and symbol chips, parented to their diagram nodes (parents-first). */
  nodes: MapRfNode[];
  /** Module-internal import edges between rendered file cards. */
  edges: RfEdge[];
  /** Required container size per expanded diagram node id. */
  sizes: Map<string, { width: number; height: number }>;
  /** Expanded node ids whose module detail hasn't arrived yet. */
  loading: Set<string>;
}

/**
 * Importance of a file within its module: intra-module connectivity first,
 * public surface second. Shared by the expanded view (which files survive the
 * cap) and the collapsed block preview, so the preview shows exactly the files
 * that expansion will.
 */
function fileImportanceOf(detail: CodeModuleDetail): (f: CodeFileSummary) => number {
  const degree = new Map<string, number>();
  for (const e of detail.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  return (f) => (degree.get(f.path) ?? 0) * 2 + f.exportCount;
}

/**
 * What a collapsed, code-linked block shows at medium zoom: its most important
 * files as chips. Pure summary — the reserved slot's geometry never changes,
 * the box just uses its area for information instead of empty space.
 */
export interface BlockPreview {
  files: { name: string; dir: string; exports: number }[];
  /** Files beyond the preview cap. */
  more: number;
  totalFiles: number;
  totalExports: number;
}

export function buildBlockPreview(detail: CodeModuleDetail): BlockPreview {
  const importance = fileImportanceOf(detail);
  const ranked = [...detail.files].sort((a, b) => importance(b) - importance(a));
  const files = ranked
    .slice(0, LIVE_FILE_CAP)
    .map((f) => ({ name: f.name, dir: f.dir, exports: f.exportCount }));
  return {
    files,
    more: detail.files.length - files.length,
    totalFiles: detail.files.length,
    totalExports: detail.files.reduce((s, f) => s + f.exportCount, 0),
  };
}

export function buildCodeContent(input: CodeContentInput): CodeContent {
  const nodes: MapRfNode[] = [];
  const edges: RfEdge[] = [];
  const sizes = new Map<string, { width: number; height: number }>();
  const loading = new Set<string>();

  for (const [nodeId, modulePath] of input.expanded) {
    const detail = input.moduleDetails.get(modulePath);
    if (!detail) {
      loading.add(nodeId);
      sizes.set(nodeId, CODE_LOADING_SIZE);
      continue;
    }

    // A file the user is refactoring (expanded, or on a move intent) never
    // hides behind the cap — dragging it is the whole point of the view.
    const pinned = (path: string): boolean =>
      input.expandedFiles.has(path) ||
      input.moves.some((m) => m.fromFile === path || (m.kind === "move" && m.toFile === path));

    const importance = fileImportanceOf(detail);

    const showAll = input.showAllFiles?.has(nodeId) ?? false;
    let summaries = detail.files;
    if (!showAll && summaries.length > LIVE_FILE_CAP) {
      const keep = new Set(
        [...summaries].sort((a, b) => importance(b) - importance(a)).slice(0, LIVE_FILE_CAP).map((f) => f.path),
      );
      for (const f of summaries) if (pinned(f.path)) keep.add(f.path);
      summaries = summaries.filter((f) => keep.has(f.path));
    }
    const hiddenCount = detail.files.length - summaries.length;

    const flavor = moduleFlavorOf(detail.files.map(relPathOf));
    const files = summaries.map((f) => ({
      built: buildFile(f.path, f.name, modulePath, f.exportCount, input, input.moves),
      rank: roleRank(roleOfFile(relPathOf(f), flavor), flavor),
    }));
    const shownFiles = new Set(summaries.map((f) => f.path));
    const allFiles = new Set(detail.files.map((f) => f.path));

    // Ghost cards for whole files planned to move INTO this module.
    for (const mv of input.moves) {
      if (mv.kind !== "moveFile" || mv.toModule !== modulePath) continue;
      if (allFiles.has(mv.fromFile)) continue;
      files.push({ built: plannedFileCard(mv, modulePath), rank: Number.POSITIVE_INFINITY });
    }

    // Capped module: a chip that reveals the rest (or folds them again).
    if (detail.files.length > LIVE_FILE_CAP) {
      files.push({
        built: overflowChip(nodeId, hiddenCount, showAll, accentFor(modulePath)),
        rank: Number.POSITIVE_INFINITY,
      });
    }

    const packed = packRoleBands(files);
    for (const { built: f } of files) {
      const pos = packed.pos.get(f.node.id)!;
      f.node.parentId = nodeId;
      f.node.position = { x: MODULE_PAD + pos.x, y: ARCH_CODE_HEADER_H + pos.y };
      f.node.deletable = false;
      f.node.className = "lod-child";
      nodes.push(f.node);
      for (const s of f.symbols) {
        s.deletable = false;
        s.className = "lod-child";
        nodes.push(s);
      }
    }
    sizes.set(nodeId, {
      width: Math.max(packed.width + MODULE_PAD * 2, 224),
      height: ARCH_CODE_HEADER_H + packed.height + MODULE_PAD,
    });

    // Edge declutter: small modules draw their full import web; dense ones
    // only the edges touching a file the user is working with — everything
    // else is hairball, not information.
    const dense = shownFiles.size > EDGE_FULL_LIMIT;
    for (const e of detail.edges) {
      if (!shownFiles.has(e.source) || !shownFiles.has(e.target)) continue;
      if (dense && !pinned(e.source) && !pinned(e.target)) continue;
      edges.push({
        id: `code:${e.source}->${e.target}`,
        source: fileId(e.source),
        target: fileId(e.target),
        className: "lod-child",
        style: { stroke: "var(--color-edge-strong)", strokeWidth: 1, opacity: 0.6 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-edge-strong)", width: 12, height: 12 },
      });
    }
  }

  return { nodes, edges, sizes, loading };
}

/** Module-relative path of a file summary (role heuristics never see the module prefix). */
function relPathOf(f: CodeFileSummary): string {
  return f.dir ? `${f.dir}/${f.name}` : f.name;
}

/**
 * Skeletal footprint of a node expanded to module level (capped file cards,
 * collapsed): the space auto-layout reserves up front, so zooming in fills a
 * slot that already exists instead of colliding with neighbors. Deliberately
 * generous — role bands wrap independently, so two spare rows and the band
 * gaps are budgeted; must always contain the actual collapsed-cards packing.
 */
export function estimateModuleFootprint(fileCount: number): { width: number; height: number } {
  const cards = Math.min(fileCount, LIVE_FILE_CAP) + (fileCount > LIVE_FILE_CAP ? 1 : 0);
  const perRow = Math.max(1, Math.floor((MODULE_INNER_MAX_W + GAP) / (FILE_COLLAPSED_W + GAP)));
  // Worst case: cards spread across every role band (≤5 distinct ranks), each
  // band wrapping separately — one extra partial row and one gap per band.
  const bands = Math.min(cards, 5);
  const rows = Math.ceil(cards / perRow) + (bands - 1);
  const cols = Math.min(cards, perRow);
  const width = cols * (FILE_COLLAPSED_W + GAP) - GAP + MODULE_PAD * 2;
  const height =
    ARCH_CODE_HEADER_H +
    rows * (FILE_COLLAPSED_H + GAP) -
    GAP +
    (bands - 1) * BAND_GAP_Y +
    MODULE_PAD;
  return { width: Math.max(width, 224), height: Math.max(height, 96) };
}

/** Extra breathing room between role bands, beyond the in-band grid gap. */
const BAND_GAP_Y = 20;

/**
 * Pack file cards into horizontal role bands: files sharing a role rank pack
 * into one wrapped grid, bands stack top-down in rank order (entry above
 * service above data; providers above layouts above components).
 */
function packRoleBands(files: readonly { built: BuiltFile; rank: number }[]): {
  pos: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
} {
  const ranks = [...new Set(files.map((f) => f.rank))].sort((a, b) => a - b);
  const pos = new Map<string, { x: number; y: number }>();
  let y = 0;
  let width = 0;
  for (const rank of ranks) {
    const band = files.filter((f) => f.rank === rank);
    const packed = packGrid(
      band.map(({ built }) => ({ id: built.node.id, w: built.w, h: built.h })),
      MODULE_INNER_MAX_W,
    );
    for (const [id, p] of packed.pos) pos.set(id, { x: p.x, y: y + p.y });
    width = Math.max(width, packed.width);
    y += packed.height + BAND_GAP_Y;
  }
  return { pos, width, height: files.length ? y - BAND_GAP_Y : 0 };
}

/** Id of a module's "+N more files" chip (recognized as a code child by the canvas). */
export const overflowChipId = (nodeId: string) => `morefiles:${nodeId}`;

function overflowChip(nodeId: string, hidden: number, showingAll: boolean, accent: string): BuiltFile {
  return {
    node: {
      id: overflowChipId(nodeId),
      type: "codeOverflow",
      position: { x: 0, y: 0 },
      width: FILE_COLLAPSED_W,
      height: OVERFLOW_CHIP_H,
      draggable: false,
      selectable: false,
      data: { nodeKind: "overflow", nodeId, hidden, showingAll, accent },
    } as MapRfNode,
    symbols: [],
    w: FILE_COLLAPSED_W,
    h: OVERFLOW_CHIP_H,
  };
}

function plannedFileCard(mv: MoveFileIntent, modulePath: string) {
  return {
    node: {
      id: `planfile:${mv.id}`,
      type: "codeFile",
      position: { x: 0, y: 0 },
      width: FILE_COLLAPSED_W,
      height: FILE_COLLAPSED_H,
      draggable: false,
      selectable: false,
      data: {
        nodeKind: "file",
        path: mv.fromFile,
        module: modulePath,
        name: mv.fromFile.split("/").pop()!,
        accent: accentFor(modulePath),
        expanded: false,
        planned: true,
      } satisfies FileNodeData,
    } as MapRfNode,
    symbols: [] as MapRfNode[],
    w: FILE_COLLAPSED_W,
    h: FILE_COLLAPSED_H,
  };
}

/** Minimal live node shape for drop-target hit tests (react-flow nodes fit). */
export interface HitTestNode extends PositionedNode {
  width?: number;
  height?: number;
  measured?: { width?: number; height?: number };
  data: Record<string, unknown>;
}

/**
 * Drop target for a dragged symbol chip or file card on the unified canvas:
 * a file card under the point wins, else the deepest diagram node that maps
 * to a code module. The drag source's own file and own module are not targets.
 */
export function unifiedDropTargetAt(
  nodes: readonly HitTestNode[],
  center: { x: number; y: number },
  source: { file: string; module: string },
  moduleOfDiagramNode: (id: string) => string | null,
): DropTarget | null {
  const contains = (n: HitTestNode): boolean => {
    const abs = absolutePositionOf(nodes, n.id);
    if (!abs) return false;
    const w = n.measured?.width ?? n.width ?? 0;
    const h = n.measured?.height ?? n.height ?? 0;
    return center.x >= abs.x && center.x <= abs.x + w && center.y >= abs.y && center.y <= abs.y + h;
  };
  const depthOf = (n: HitTestNode): number => {
    const byId = new Map(nodes.map((x) => [x.id, x]));
    let depth = 0;
    let cur: HitTestNode | undefined = n;
    while (cur?.parentId) {
      depth++;
      cur = byId.get(cur.parentId);
    }
    return depth;
  };

  for (const n of nodes) {
    if (n.data.nodeKind !== "file") continue;
    const d = n.data as { path: string; module: string; planned?: boolean };
    if (d.planned || d.path === source.file) continue;
    if (contains(n)) return { module: d.module, file: d.path };
  }

  let best: DropTarget | null = null;
  let bestDepth = -1;
  for (const n of nodes) {
    if (n.data.nodeKind != null || !("arch" in n.data)) continue; // diagram nodes only
    const module = moduleOfDiagramNode(n.id);
    if (!module || module === source.module) continue;
    if (!contains(n)) continue;
    const depth = depthOf(n);
    if (depth > bestDepth) {
      best = { module };
      bestDepth = depth;
    }
  }
  return best;
}
