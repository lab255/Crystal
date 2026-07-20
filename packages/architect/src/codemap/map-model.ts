import dagre from "@dagrejs/dagre";
import { MarkerType, type Edge as RfEdge, type Node as RfNode } from "@xyflow/react";
import type {
  CodeFileDetail,
  CodeMapSummary,
  CodeModule,
  CodeModuleDep,
  CodeModuleDetail,
  CodeSymbolKind,
  MoveFileIntent,
  MoveIntent,
} from "@crystal/core";

/** The intent kinds the map renders as overlays (hoists live in panels). */
export type MoveLikeIntent = MoveIntent | MoveFileIntent;

/**
 * Nested code-map scene: modules are group containers holding file cards,
 * file cards expand into symbol chips, symbol chips expand into source.
 * Everything is derived — this module turns (summary + on-demand details +
 * expansion state + draft move intents) into react-flow nodes/edges with
 * parents before children and parent-relative child positions.
 *
 * Edges stay aggregated (module → module); the only file-level edges drawn
 * are for the selected file, so the canvas reads as groups you zoom into
 * rather than a dataflow hairball.
 */

/* ---- geometry (deterministic; layout math and tests share these) ---- */

export const SYM_W = 168;
export const SYM_H = 28;
export const CODE_H = 224;
export const GAP = 8;
export const FILE_PAD = 10;
export const FILE_HEADER_H = 34;
export const FILE_COLLAPSED_W = 200;
export const FILE_COLLAPSED_H = 46;
/** Two symbol columns. */
export const FILE_INNER_W = SYM_W * 2 + GAP;
export const FILE_EXPANDED_W = FILE_INNER_W + FILE_PAD * 2;
export const MODULE_PAD = 12;
export const MODULE_HEADER_H = 40;
export const MODULE_COLLAPSED_W = 224;
export const MODULE_COLLAPSED_H = 64;
/** Wrap width for file cards inside an expanded module (~2 expanded files). */
export const MODULE_INNER_MAX_W = FILE_EXPANDED_W * 2 + GAP * 2;
/** Symbol chips shown per file before "+N more" (full list in the side panel). */
export const MAX_SYMBOLS_SHOWN = 24;

const ACCENTS = [
  "var(--color-accent-violet)",
  "var(--color-accent-cyan)",
  "var(--color-accent-emerald)",
  "var(--color-accent-amber)",
  "var(--color-accent-blue)",
  "var(--color-accent-rose)",
  "var(--color-accent-slate)",
];

export function accentFor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return ACCENTS[Math.abs(hash) % ACCENTS.length]!;
}

/* ---- node ids ---- */

export const moduleId = (path: string) => `m:${path}`;
export const fileId = (path: string) => `f:${path}`;
export const symbolId = (file: string, symbol: string) => `s:${file}#${symbol}`;
export const codeKey = (file: string, symbol: string) => `${file}#${symbol}`;

/** Longest module path that prefixes `path` ("." when nothing else matches). */
export function moduleOfPath(path: string, modules: readonly CodeModule[]): string {
  let best = ".";
  for (const m of modules) {
    if (m.path === ".") continue;
    if ((path === m.path || path.startsWith(m.path + "/")) && m.path.length > best.length) {
      best = m.path;
    }
  }
  return best;
}

/* ---- node data ---- */

export interface ModuleNodeData extends Record<string, unknown> {
  nodeKind: "module";
  path: string;
  name: string;
  accent: string;
  fileCount: number;
  /** Top-level members across the module's files (known once details load). */
  memberCount?: number;
  expanded: boolean;
  loading?: boolean;
  truncated?: boolean;
  intentMark?: "source" | "target";
  emphasis?: boolean;
  /** Lens-context neighbor — rendered muted, outside the facet itself. */
  dimmed?: boolean;
}

export interface FileNodeData extends Record<string, unknown> {
  nodeKind: "file";
  path: string;
  module: string;
  name: string;
  accent: string;
  exportCount?: number;
  expanded: boolean;
  loading?: boolean;
  /** Symbols hidden by the display cap. */
  overflow?: number;
  intentMark?: "source" | "target";
  emphasis?: boolean;
  /** Ghost card in the move-target module — exists only on the draft plan. */
  planned?: boolean;
  /** Card with a pending whole-file move out of its module. */
  moving?: boolean;
  /** "→ dest" caption for a moving card. */
  moveLabel?: string;
}

export interface SymbolNodeData extends Record<string, unknown> {
  nodeKind: "symbol";
  file: string;
  module: string;
  name: string;
  kind: CodeSymbolKind;
  line: number;
  exported: boolean;
  accent: string;
  codeOpen: boolean;
  /** Ghost chip in the move target — exists only on the draft plan. */
  planned?: boolean;
  /** Chip with a pending move out of this file. */
  moving?: boolean;
  /** "→ dest" caption for a moving chip. */
  moveLabel?: string;
}

/** "+N more files" chip inside a capped expanded module (unified canvas). */
export interface OverflowNodeData extends Record<string, unknown> {
  nodeKind: "overflow";
  /** Diagram node whose module is capped — the toggle target. */
  nodeId: string;
  /** Files hidden by the cap (0 while showing all). */
  hidden: number;
  showingAll: boolean;
  accent: string;
}

export type MapNodeData = ModuleNodeData | FileNodeData | SymbolNodeData | OverflowNodeData;
export type MapRfNode = RfNode<MapNodeData>;

/* ---- facet lens ---- */

/**
 * A facet lens over the map: which files are visible and, per file, which
 * members ("all" = the whole file carries the facet). Modules, files and
 * symbol chips outside the lens are not rendered. Shape mirrors
 * `IndexFacetVisibility` from core so the two convert trivially.
 */
export interface MapLens {
  files: ReadonlyMap<string, "all" | ReadonlySet<string>>;
  /**
   * Directory prefixes whose files are wholly in the lens — structural
   * lenses (a system's parts) that need no per-file enumeration.
   */
  dirs?: readonly string[];
  modules: ReadonlySet<string>;
  /**
   * First-degree neighbor modules (an import edge to/from a lens member),
   * disjoint from `modules`. Rendered collapsed and dimmed for context —
   * their files are outside the lens.
   */
  context?: ReadonlySet<string>;
}

/**
 * Globally resolved lens membership (a diff or saved facet — plain member
 * files + directory prefixes from the client lens store) → the same core the
 * tag pipeline builds: whole-file member map, dir prefixes, and the set of
 * modules owning any member. Null when the membership is empty (a clean
 * working tree resolves to nothing, not to "everything").
 */
export function membershipLensCore(
  membership: { files: readonly string[]; dirs: readonly string[] },
  modules: readonly CodeModule[],
): { files: Map<string, "all">; dirs: string[]; modules: Set<string>; fileCount: number } | null {
  if (membership.files.length === 0 && membership.dirs.length === 0) return null;
  const files = new Map<string, "all">();
  const owning = new Set<string>();
  for (const f of membership.files) {
    files.set(f, "all");
    owning.add(moduleOfPath(f, modules));
  }
  const dirs = [...membership.dirs];
  for (const d of dirs) {
    owning.add(moduleOfPath(d, modules));
    // A membership dir can sit *above* module roots (e.g. "packages") — every
    // module inside it is owned too.
    for (const m of modules) if (m.path === d || m.path.startsWith(`${d}/`)) owning.add(m.path);
  }
  return { files, dirs, modules: owning, fileCount: membership.files.length };
}

/** What the lens exposes of one file: everything, some members, or nothing. */
export function lensFileVisibility(
  lens: MapLens,
  path: string,
): "all" | ReadonlySet<string> | undefined {
  const direct = lens.files.get(path);
  if (direct) return direct;
  return lens.dirs?.some((d) => path === d || path.startsWith(`${d}/`)) ? "all" : undefined;
}

/* ---- scene input ---- */

/** The slice of scene input `buildFile` needs (also used by the unified diagram canvas). */
export interface FileBuildInput {
  fileDetails: ReadonlyMap<string, CodeFileDetail>;
  expandedFiles: ReadonlySet<string>;
  /** `${file}#${symbol}` keys with the source snippet open. */
  openCode: ReadonlySet<string>;
  /** Node id to visually emphasize (drill target). */
  focusId?: string | null;
  /** Active facet lens — hides files/members outside it. */
  lens?: MapLens | null;
}

export interface MapSceneInput extends FileBuildInput {
  summary: CodeMapSummary;
  moduleDetails: ReadonlyMap<string, CodeModuleDetail>;
  expandedModules: ReadonlySet<string>;
  /** Move intents on the active draft — rendered as ghosts/marks. */
  moves: readonly MoveLikeIntent[];
  /** File whose import neighborhood is drawn as edges. */
  selectedFile?: string | null;
  /** Manual module positions (drag overrides), by module path. */
  positions?: ReadonlyMap<string, { x: number; y: number }>;
  /**
   * Per-module layout footprints (the members-level estimate). When present,
   * dagre lays modules out at these sizes regardless of what is currently
   * expanded, so sliding the level of detail never re-arranges the map —
   * collapsed cards sit centered in the slot their exposed form would fill.
   */
  layoutSizes?: ReadonlyMap<string, { w: number; h: number }>;
  /** Per-module member totals for the header badge (module path → count). */
  memberCounts?: ReadonlyMap<string, number>;
}

export interface MapScene {
  nodes: MapRfNode[];
  edges: RfEdge[];
}

/* ---- grid packing ---- */

interface PackItem {
  id: string;
  w: number;
  h: number;
}

export function packGrid(
  items: readonly PackItem[],
  maxW: number,
  gap: number = GAP,
): { pos: Map<string, { x: number; y: number }>; width: number; height: number } {
  const pos = new Map<string, { x: number; y: number }>();
  let x = 0;
  let y = 0;
  let rowH = 0;
  let width = 0;
  for (const item of items) {
    if (x > 0 && x + item.w > maxW) {
      y += rowH + gap;
      x = 0;
      rowH = 0;
    }
    pos.set(item.id, { x, y });
    width = Math.max(width, x + item.w);
    rowH = Math.max(rowH, item.h);
    x += item.w + gap;
  }
  return { pos, width, height: items.length ? y + rowH : 0 };
}

/* ---- edge styles ---- */

function depEdge(source: string, target: string, weight: number): RfEdge {
  return {
    id: `dep:${source}->${target}`,
    source: moduleId(source),
    target: moduleId(target),
    style: {
      stroke: "var(--color-edge-strong)",
      strokeWidth: Math.min(1 + Math.log2(weight + 1), 4),
      opacity: 0.75,
    },
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-edge-strong)", width: 14, height: 14 },
    label: weight > 1 ? String(weight) : undefined,
    labelStyle: { fill: "var(--color-ink-faint)", fontSize: 9 },
    labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.9 },
  };
}

function selectionEdge(id: string, source: string, target: string, count: number, incoming: boolean): RfEdge {
  return {
    id,
    source,
    target,
    animated: true,
    style: {
      stroke: incoming ? "var(--color-prism-400)" : "var(--color-crystal-400)",
      strokeWidth: Math.min(1.6 + Math.log2(count + 1) * 0.6, 3.5),
      opacity: 0.95,
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: incoming ? "var(--color-prism-400)" : "var(--color-crystal-400)",
      width: 15,
      height: 15,
    },
    label: count > 1 ? String(count) : undefined,
    labelStyle: { fill: incoming ? "var(--color-prism-400)" : "var(--color-crystal-400)", fontSize: 9 },
    labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.9 },
  };
}

/* ---- scene builder ---- */

export interface BuiltFile {
  node: MapRfNode;
  symbols: MapRfNode[];
  w: number;
  h: number;
}

export function buildMapScene(input: MapSceneInput): MapScene {
  const { summary, lens } = input;
  const moves = input.moves;

  const visibleModules = summary.modules.filter(
    (m) =>
      (m.fileCount > 0 || summary.deps.some((d) => d.source === m.path || d.target === m.path)) &&
      (!lens || lens.modules.has(m.path) || lens.context?.has(m.path)),
  );
  const modulePathSet = new Set(visibleModules.map((m) => m.path));

  // intent marks on module headers (file marks are computed per file card)
  const moduleMark = new Map<string, "source" | "target">();
  const markModule = (path: string, mark: "source" | "target") => {
    if (mark === "target" || !moduleMark.has(path)) moduleMark.set(path, mark);
  };
  for (const mv of moves) {
    markModule(moduleOfPath(mv.fromFile, summary.modules), "source");
    markModule(mv.toModule, "target");
  }

  const builtFileIds = new Set<string>();
  const moduleBuilds: {
    module: CodeModule;
    expanded: boolean;
    detail: CodeModuleDetail | undefined;
    files: BuiltFile[];
    w: number;
    h: number;
  }[] = [];

  for (const m of visibleModules) {
    // Context neighbors always render collapsed — their files are outside the
    // lens, so expanding them would show an empty shell.
    const isContext = lens?.context?.has(m.path) ?? false;
    const expanded = !isContext && input.expandedModules.has(m.path);
    const detail = expanded ? input.moduleDetails.get(m.path) : undefined;
    if (!expanded || !detail) {
      moduleBuilds.push({
        module: m,
        expanded,
        detail: undefined,
        files: [],
        w: MODULE_COLLAPSED_W,
        h: MODULE_COLLAPSED_H,
      });
      continue;
    }

    const shownFiles = lens
      ? detail.files.filter((f) => lensFileVisibility(lens, f.path) != null)
      : detail.files;
    const files: BuiltFile[] = shownFiles.map((f) =>
      buildFile(f.path, f.name, m.path, f.exportCount, input, moves),
    );
    for (const f of files) builtFileIds.add(f.node.id);

    // ghost cards for whole files planned to move INTO this module
    for (const mv of moves) {
      if (mv.kind !== "moveFile" || mv.toModule !== m.path) continue;
      if (detail.files.some((f) => f.path === mv.fromFile)) continue; // already here
      files.push({
        node: {
          id: `planfile:${mv.id}`,
          type: "codeFile",
          parentId: moduleId(m.path),
          position: { x: 0, y: 0 },
          width: FILE_COLLAPSED_W,
          height: FILE_COLLAPSED_H,
          draggable: false,
          selectable: false,
          data: {
            nodeKind: "file",
            path: mv.fromFile,
            module: m.path,
            name: mv.fromFile.split("/").pop()!,
            accent: accentFor(m.path),
            expanded: false,
            planned: true,
          },
        },
        symbols: [],
        w: FILE_COLLAPSED_W,
        h: FILE_COLLAPSED_H,
      });
    }

    const packed = packGrid(
      files.map((f) => ({ id: f.node.id, w: f.w, h: f.h })),
      MODULE_INNER_MAX_W,
    );
    for (const f of files) {
      const pos = packed.pos.get(f.node.id)!;
      f.node.position = { x: MODULE_PAD + pos.x, y: MODULE_HEADER_H + pos.y };
    }
    moduleBuilds.push({
      module: m,
      expanded: true,
      detail,
      files,
      w: Math.max(packed.width, MODULE_COLLAPSED_W - MODULE_PAD * 2) + MODULE_PAD * 2,
      h: MODULE_HEADER_H + packed.height + MODULE_PAD,
    });
  }

  // top-level layout: dagre over module containers with their computed sizes,
  // top-to-bottom so dependencies read downward like the diagram view
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 56, ranksep: 96, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const b of moduleBuilds) {
    const reserve = input.layoutSizes?.get(b.module.path);
    g.setNode(b.module.path, {
      width: Math.max(b.w, reserve?.w ?? 0),
      height: Math.max(b.h, reserve?.h ?? 0),
    });
  }
  // With a lens active, an edge must touch a lens member — context modules
  // connect to the facet, never to each other.
  const depVisible = (d: CodeModuleDep) =>
    d.source !== d.target &&
    modulePathSet.has(d.source) &&
    modulePathSet.has(d.target) &&
    (!lens || lens.modules.has(d.source) || lens.modules.has(d.target));
  for (const d of summary.deps) {
    if (depVisible(d)) g.setEdge(d.source, d.target);
  }
  dagre.layout(g);

  const nodes: MapRfNode[] = [];
  const childNodes: MapRfNode[] = [];

  for (const b of moduleBuilds) {
    const dagrePos = g.node(b.module.path);
    const override = input.positions?.get(b.module.path);
    const position = override ?? { x: dagrePos.x - b.w / 2, y: dagrePos.y - b.h / 2 };
    const id = moduleId(b.module.path);
    nodes.push({
      id,
      type: "codeModule",
      position,
      width: b.w,
      height: b.h,
      draggable: true,
      data: {
        nodeKind: "module",
        path: b.module.path,
        name: b.module.name,
        accent: accentFor(b.module.path),
        fileCount: b.module.fileCount,
        memberCount: input.memberCounts?.get(b.module.path),
        expanded: b.expanded && b.detail != null,
        loading: b.expanded && b.detail == null,
        truncated: b.detail?.truncated,
        intentMark: moduleMark.get(b.module.path),
        emphasis: input.focusId === id,
        dimmed: lens?.context?.has(b.module.path) || undefined,
      },
    });
    for (const f of b.files) {
      childNodes.push(f.node, ...f.symbols);
    }
  }

  // parents before children (react-flow requirement)
  nodes.push(...childNodes);

  /* ---- edges ---- */
  const edges: RfEdge[] = [];
  for (const d of summary.deps) {
    if (!depVisible(d)) continue;
    edges.push(depEdge(d.source, d.target, d.weight));
  }

  // import neighborhood of the selected file
  const sel = input.selectedFile;
  if (sel && builtFileIds.has(fileId(sel))) {
    const detail = input.fileDetails.get(sel);
    if (detail) {
      const selId = fileId(sel);
      const agg = new Map<string, { target: string; count: number; incoming: boolean }>();
      const add = (otherPath: string, otherModule: string, incoming: boolean) => {
        const other =
          builtFileIds.has(fileId(otherPath)) ? fileId(otherPath)
          : modulePathSet.has(otherModule) ? moduleId(otherModule)
          : null;
        if (!other || other === selId || other === moduleId(moduleOfPath(sel, summary.modules))) return;
        const key = `${incoming ? "in" : "out"}:${other}`;
        const entry = agg.get(key) ?? { target: other, count: 0, incoming };
        entry.count += 1;
        agg.set(key, entry);
      };
      const seen = new Set<string>();
      for (const imp of detail.imports) {
        if (!imp.resolved || imp.resolved === sel || seen.has(imp.resolved)) continue;
        seen.add(imp.resolved);
        add(imp.resolved, imp.targetModule ?? moduleOfPath(imp.resolved, summary.modules), false);
      }
      for (const by of detail.importedBy) {
        add(by, moduleOfPath(by, summary.modules), true);
      }
      for (const [key, e] of agg) {
        edges.push(
          e.incoming
            ? selectionEdge(`sel:${key}`, e.target, selId, e.count, true)
            : selectionEdge(`sel:${key}`, selId, e.target, e.count, false),
        );
      }
    }
  }

  return { nodes, edges };
}

/**
 * One file card (collapsed, loading, or expanded into symbol chips) parented
 * to its module container. The unified diagram canvas re-parents the returned
 * nodes onto diagram nodes.
 */
export function buildFile(
  path: string,
  name: string,
  module: string,
  exportCount: number | undefined,
  input: FileBuildInput,
  moves: readonly MoveLikeIntent[],
): BuiltFile {
  const expanded = input.expandedFiles.has(path);
  const detail = expanded ? input.fileDetails.get(path) : undefined;
  const id = fileId(path);
  const parentId = moduleId(module);
  const accent = accentFor(module);
  const marks = fileMarksFor(path, moves);
  const fileMove = moves.find(
    (m): m is MoveFileIntent => m.kind === "moveFile" && m.fromFile === path,
  );

  // NB: not Omit<FileNodeData, …> — the Record index signature would swallow
  // the named props and the spreads below would lose their types.
  const base = {
    nodeKind: "file" as const,
    path,
    module,
    name,
    accent,
    exportCount,
    intentMark: marks,
    emphasis: input.focusId === id,
    moving: fileMove != null || undefined,
    moveLabel: fileMove ? `→ ${fileMove.toModule}` : undefined,
  };

  if (!expanded) {
    return {
      node: {
        id,
        type: "codeFile",
        parentId,
        position: { x: 0, y: 0 },
        width: FILE_COLLAPSED_W,
        height: FILE_COLLAPSED_H,
        draggable: true,
        data: { ...base, expanded: false },
      },
      symbols: [],
      w: FILE_COLLAPSED_W,
      h: FILE_COLLAPSED_H,
    };
  }

  if (!detail) {
    // expanded but still loading — render a slightly taller shell
    return {
      node: {
        id,
        type: "codeFile",
        parentId,
        position: { x: 0, y: 0 },
        width: FILE_EXPANDED_W,
        height: FILE_COLLAPSED_H + 24,
        draggable: true,
        data: { ...base, expanded: true, loading: true },
      },
      symbols: [],
      w: FILE_EXPANDED_W,
      h: FILE_COLLAPSED_H + 24,
    };
  }

  const symbolMoves = moves.filter((m): m is MoveIntent => m.kind === "move");
  const lensMembers = input.lens ? lensFileVisibility(input.lens, path) : undefined;
  const all =
    lensMembers && lensMembers !== "all"
      ? (detail.symbols ?? detail.exports).filter((s) => lensMembers.has(s.name))
      : (detail.symbols ?? detail.exports);
  const ordered = [...all].sort((a, b) => {
    const ax = a.exported === false ? 1 : 0;
    const bx = b.exported === false ? 1 : 0;
    return ax - bx || a.line - b.line;
  });
  const shown = ordered.slice(0, MAX_SYMBOLS_SHOWN);
  const overflow = ordered.length - shown.length;

  const items: PackItem[] = [];
  const symbolNodes: MapRfNode[] = [];
  for (const sym of shown) {
    const open = input.openCode.has(codeKey(path, sym.name));
    const move = symbolMoves.find((m) => m.fromFile === path && m.symbol === sym.name);
    const sid = symbolId(path, sym.name);
    const w = open ? FILE_INNER_W : SYM_W;
    const h = open ? SYM_H + CODE_H : SYM_H;
    items.push({ id: sid, w, h });
    symbolNodes.push({
      id: sid,
      type: "codeSymbol",
      position: { x: 0, y: 0 },
      parentId: id,
      width: w,
      height: h,
      draggable: sym.kind !== "reexport",
      data: {
        nodeKind: "symbol",
        file: path,
        module,
        name: sym.name,
        kind: sym.kind,
        line: sym.line,
        exported: sym.exported !== false,
        accent,
        codeOpen: open,
        moving: move != null,
        moveLabel: move ? `→ ${move.toFile ? move.toFile.split("/").pop() : move.toModule}` : undefined,
      },
    });
  }

  // ghost chips for symbol moves planned INTO this file
  for (const mv of symbolMoves) {
    if (mv.toFile !== path) continue;
    const gid = `plan:${mv.id}`;
    const srcDetail = input.fileDetails.get(mv.fromFile);
    const srcSym = (srcDetail?.symbols ?? srcDetail?.exports)?.find((s) => s.name === mv.symbol);
    items.push({ id: gid, w: SYM_W, h: SYM_H });
    symbolNodes.push({
      id: gid,
      type: "codeSymbol",
      position: { x: 0, y: 0 },
      parentId: id,
      width: SYM_W,
      height: SYM_H,
      draggable: false,
      selectable: false,
      data: {
        nodeKind: "symbol",
        file: mv.fromFile,
        module,
        name: mv.symbol,
        kind: srcSym?.kind ?? "function",
        line: srcSym?.line ?? 0,
        exported: srcSym?.exported !== false,
        accent,
        codeOpen: false,
        planned: true,
      },
    });
  }

  const packed = packGrid(items, FILE_INNER_W);
  for (const s of symbolNodes) {
    const pos = packed.pos.get(s.id)!;
    s.position = { x: FILE_PAD + pos.x, y: FILE_HEADER_H + pos.y };
  }
  const w = FILE_EXPANDED_W;
  const h = FILE_HEADER_H + packed.height + FILE_PAD + (overflow > 0 ? 18 : 0);
  return {
    node: {
      id,
      type: "codeFile",
      parentId,
      position: { x: 0, y: 0 },
      width: w,
      height: h,
      draggable: true,
      data: { ...base, expanded: true, overflow: overflow > 0 ? overflow : undefined },
    },
    symbols: symbolNodes,
    w,
    h,
  };
}

/* ---- LoD footprints ---- */

/** Footprint of one file card expanded to its symbol chips (no open code). */
export function expandedFileFootprint(symbolCount: number): { w: number; h: number } {
  const shown = Math.min(symbolCount, MAX_SYMBOLS_SHOWN);
  const packed = packGrid(
    Array.from({ length: shown }, (_, i) => ({ id: String(i), w: SYM_W, h: SYM_H })),
    FILE_INNER_W,
  );
  const overflow = symbolCount - shown;
  return {
    w: FILE_EXPANDED_W,
    h: FILE_HEADER_H + packed.height + FILE_PAD + (overflow > 0 ? 18 : 0),
  };
}

/**
 * A module's members-level footprint — every file expanded to its symbol
 * chips — for the LoD-stable layout (`MapSceneInput.layoutSizes`). Mirrors
 * the geometry `buildMapScene` produces when everything is expanded, so the
 * fully exposed view fits exactly the slots coarser levels were laid out on.
 */
export function memberFootprint(
  detail: CodeModuleDetail,
  symbolCountOf: (path: string) => number,
): { w: number; h: number } {
  const packed = packGrid(
    detail.files.map((f) => {
      const fp = expandedFileFootprint(symbolCountOf(f.path));
      return { id: f.path, w: fp.w, h: fp.h };
    }),
    MODULE_INNER_MAX_W,
  );
  return {
    w: Math.max(packed.width, MODULE_COLLAPSED_W - MODULE_PAD * 2) + MODULE_PAD * 2,
    h: MODULE_HEADER_H + packed.height + MODULE_PAD,
  };
}

/* ---- repository grouping (the "repos" LoD level) ---- */

export interface RepoGroup {
  /** Module path of the repository root ("." = the workspace's own repo). */
  path: string;
  name: string;
  /** Code-bearing modules riding this repository's history. */
  modules: CodeModule[];
  fileCount: number;
}

/**
 * Group modules by the repository that versions them: nested modules with
 * their own `.git` (`versioned`) are repositories of their own; everything
 * else rides the workspace root repo. Module deps aggregate along the same
 * mapping (self-edges dropped, weights summed).
 */
export function groupModulesByRepo(summary: CodeMapSummary): {
  repos: RepoGroup[];
  repoOf: Map<string, string>;
  deps: CodeModuleDep[];
} {
  const repoRoots = summary.modules
    .filter((m) => m.versioned)
    .map((m) => m.path)
    .sort((a, b) => b.length - a.length);
  const repoOf = new Map<string, string>();
  for (const m of summary.modules) {
    repoOf.set(
      m.path,
      m.versioned
        ? m.path
        : (repoRoots.find((r) => m.path === r || m.path.startsWith(r + "/")) ?? "."),
    );
  }

  const groups = new Map<string, RepoGroup>();
  for (const m of summary.modules) {
    const root = repoOf.get(m.path)!;
    let g = groups.get(root);
    if (!g) {
      const rootMod = summary.modules.find((x) => x.path === root);
      groups.set(root, (g = { path: root, name: rootMod?.name ?? root, modules: [], fileCount: 0 }));
    }
    if (m.fileCount > 0) {
      g.modules.push(m);
      g.fileCount += m.fileCount;
    }
  }

  const weights = new Map<string, number>();
  for (const d of summary.deps) {
    const source = repoOf.get(d.source) ?? ".";
    const target = repoOf.get(d.target) ?? ".";
    if (source === target) continue;
    const key = `${source}\0${target}`;
    weights.set(key, (weights.get(key) ?? 0) + d.weight);
  }
  const deps: CodeModuleDep[] = [...weights.entries()].map(([key, weight]) => {
    const [source, target] = key.split("\0") as [string, string];
    return { source, target, weight };
  });

  const repos = [...groups.values()].filter(
    (g) => g.fileCount > 0 || deps.some((d) => d.source === g.path || d.target === g.path),
  );
  return { repos, repoOf, deps };
}

function fileMarksFor(path: string, moves: readonly MoveLikeIntent[]): "source" | "target" | undefined {
  const symbolMoves = moves.filter((m) => m.kind === "move");
  if (symbolMoves.some((m) => m.toFile === path)) return "target";
  if (symbolMoves.some((m) => m.fromFile === path)) return "source";
  return undefined;
}

/** Minimal node shape the geometry helpers need (any react-flow node fits). */
export interface PositionedNode {
  id: string;
  parentId?: string;
  position: { x: number; y: number };
}

/** Absolute canvas position of a node, walking the parent chain. */
export function absolutePositionOf(
  nodes: readonly PositionedNode[],
  id: string,
): { x: number; y: number } | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let n = byId.get(id);
  if (!n) return null;
  let x = n.position.x;
  let y = n.position.y;
  while (n.parentId) {
    n = byId.get(n.parentId);
    if (!n) break;
    x += n.position.x;
    y += n.position.y;
  }
  return { x, y };
}

export interface DropTarget {
  module: string;
  file?: string;
}

/**
 * What a symbol chip dropped at `center` (absolute canvas coords) lands on:
 * the file card under the point, else the module container. Its own file and
 * own module background are not targets.
 */
export function dropTargetAt(
  nodes: readonly MapRfNode[],
  center: { x: number; y: number },
  source: { file: string; module: string },
): DropTarget | null {
  const contains = (n: MapRfNode): boolean => {
    const abs = absolutePositionOf(nodes, n.id);
    if (!abs) return false;
    const w = n.width ?? 0;
    const h = n.height ?? 0;
    return center.x >= abs.x && center.x <= abs.x + w && center.y >= abs.y && center.y <= abs.y + h;
  };
  for (const n of nodes) {
    if (n.data.nodeKind !== "file") continue;
    const d = n.data as FileNodeData;
    if (d.path === source.file) continue;
    if (contains(n)) return { module: d.module, file: d.path };
  }
  for (const n of nodes) {
    if (n.data.nodeKind !== "module") continue;
    const d = n.data as ModuleNodeData;
    if (d.path === source.module) continue;
    if (contains(n)) return { module: d.path };
  }
  return null;
}

/**
 * Where a dragged file card lands: another module (directly, or via one of
 * its file cards). Moves within the file's own module are meaningless — null.
 */
export function fileDropTargetAt(
  nodes: readonly MapRfNode[],
  center: { x: number; y: number },
  sourceFile: string,
  sourceModule: string,
): { module: string } | null {
  const hit = dropTargetAt(nodes, center, { file: sourceFile, module: sourceModule });
  if (!hit || hit.module === sourceModule) return null;
  return { module: hit.module };
}
