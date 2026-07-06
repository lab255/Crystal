import { MarkerType, type Edge as RfEdge } from "@xyflow/react";
import type { CodeFileSummary, CodeModuleDetail, MoveFileIntent } from "@crystal/core";
import {
  FILE_COLLAPSED_H,
  FILE_COLLAPSED_W,
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
 */

/** Vertical room for the diagram container's header above the file grid. */
export const ARCH_CODE_HEADER_H = 44;
/** Container size while the module detail is still loading. */
export const CODE_LOADING_SIZE = { width: 260, height: 96 };

export interface CodeContentInput extends FileBuildInput {
  /** Diagram node id → module path expanded into live code. */
  expanded: ReadonlyMap<string, string>;
  moduleDetails: ReadonlyMap<string, CodeModuleDetail>;
  /** Move intents on the active draft — rendered as ghosts/marks. */
  moves: readonly MoveLikeIntent[];
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

    const flavor = moduleFlavorOf(detail.files.map(relPathOf));
    const files = detail.files.map((f) => ({
      built: buildFile(f.path, f.name, modulePath, f.exportCount, input, input.moves),
      rank: roleRank(roleOfFile(relPathOf(f), flavor), flavor),
    }));
    const shownFiles = new Set(detail.files.map((f) => f.path));

    // Ghost cards for whole files planned to move INTO this module.
    for (const mv of input.moves) {
      if (mv.kind !== "moveFile" || mv.toModule !== modulePath) continue;
      if (shownFiles.has(mv.fromFile)) continue;
      files.push({ built: plannedFileCard(mv, modulePath), rank: Number.POSITIVE_INFINITY });
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

    for (const e of detail.edges) {
      if (!shownFiles.has(e.source) || !shownFiles.has(e.target)) continue;
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
