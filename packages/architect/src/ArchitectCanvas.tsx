import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type Node as RfNode,
  type Viewport,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  Code2,
  Copy,
  Expand,
  ExternalLink,
  FolderGit2,
  GitFork,
  Layers,
  LayoutGrid,
  Maximize2,
  MoveUpRight,
  Package,
  Paintbrush,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Route,
  Rows3,
  Shrink,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import {
  ARCH_EDGE_KINDS,
  ancestorsOf,
  archKindForCodeModule,
  createArchFacet,
  descendantsOf,
  enrichHighlight,
  filterGraphToFacet,
  formatHighlightSel,
  isContainerKind,
  matchHighlight,
  uid,
  type ArchEdgeKind,
  type ArchNodeKind,
  type ArchitectureGraph,
  type CodeFileDetail,
  type CodeLodLevel,
  type CodeMapSummary,
  type CodeModuleDetail,
  type HighlightRef,
} from "@crystal/core";
import {
  addEdge as opAddEdge,
  addNode as opAddNode,
  containerAtPoint,
  absolutePosition,
  deleteEdges,
  deleteNodes,
  reparentNode,
  updateEdge,
  updateNode,
} from "./graph-ops.js";
import { useCrystal, useNav, useNavUpdate, useWorkspaces } from "@crystal/client";
import { cn } from "@crystal/ui";
import { ContextMenu, InlineRename, type MenuEntry } from "./ContextMenu.js";
import { collapseNode, hasGeneratedChildren } from "./expand.js";
import { autoLayout } from "./layout.js";
import {
  ACCENT_CSS,
  EDGE_KIND_STYLE,
  KIND_META,
  accentOf,
  toRfEdges,
  toRfNodes,
  type AccentName,
  type ArchRfEdge,
  type ArchRfNode,
} from "./model.js";
import { ContainerNode } from "./nodes/ContainerNode.js";
import { LeafNode } from "./nodes/LeafNode.js";
import { NoteNode } from "./nodes/NoteNode.js";
import { Inspector, type NodeInsight } from "./Inspector.js";
import {
  adoptAutoLinks,
  computeOverlay,
  linkNodesToModules,
  suggestModuleFor,
  type OverlayResult,
} from "./overlay.js";
import type { FlowProjection } from "./dataflow.js";
import { requestOpenFile } from "./codemap/CodeMapView.js";
import type { SymbolDragPayload } from "./codemap/CodeNode.js";
import {
  absolutePositionOf,
  codeKey,
  fileId,
  moduleOfPath,
  type DropTarget,
  type FileNodeData,
  type MapNodeData,
  type MapRfNode,
  type MoveLikeIntent,
  type SymbolNodeData,
} from "./codemap/map-model.js";
import { MapActionsContext, mapNodeTypes, type MapActions } from "./codemap/map-nodes.js";
import {
  buildBlockPreview,
  buildCodeContent,
  estimateModuleFootprint,
  unifiedDropTargetAt,
  type BlockPreview,
  type HitTestNode,
} from "./live-code.js";
import { resolveCollisions, type DisplaceRect } from "./displace.js";
import { BusbarEdge } from "./BusbarEdge.js";
import { PeekPanel } from "./snippets.js";
import { Palette, DRAG_MIME, PALETTE_KINDS } from "./Palette.js";
import { Toolbar } from "./Toolbar.js";
import { CANVAS_LOD_LEVELS, fileExpandZoom, moduleExpandZoom, useLodConfig } from "./lod-config.js";
import { hlClass, useViewHighlight } from "./use-highlight.js";

const nodeTypes = {
  container: ContainerNode,
  leaf: LeafNode,
  note: NoteNode,
  codeFile: mapNodeTypes.codeFile,
  codeSymbol: mapNodeTypes.codeSymbol,
  codeOverflow: mapNodeTypes.codeOverflow,
};

const edgeTypes = {
  busbar: BusbarEdge,
};

type CanvasNode = ArchRfNode | MapRfNode;

/** Ephemeral live-code children carry map-model ids, never graph node ids. */
function isCodeChildId(id: string): boolean {
  return (
    id.startsWith("f:") ||
    id.startsWith("s:") ||
    id.startsWith("plan:") ||
    id.startsWith("planfile:") ||
    id.startsWith("morefiles:")
  );
}

export interface ArchitectCanvasProps {
  graph: ArchitectureGraph;
  onChange: (graph: ArchitectureGraph) => void;
  /** Live code map for the overlay + code expansion; null while unavailable. */
  codeSummary?: CodeMapSummary | null;
  overlayOn?: boolean;
  onToggleOverlay?: (on: boolean) => void;
  /** True while editing a draft plan — canvas gets a visual draft treatment. */
  draftMode?: boolean;
  /** Active journey projection — decorates the canvas as a dataflow lens. */
  flow?: FlowProjection | null;
  /** Move intents on the active draft — rendered as ghosts/marks in expanded code. */
  moves?: readonly MoveLikeIntent[];
  onStartJourney?: (seed: { file: string; symbol: string }) => void;
  /** Record a symbol move intent (drag or menu) on the active/auto-created draft. */
  onRecordMove?: (payload: SymbolDragPayload, target: DropTarget) => void;
  onRecordFileMove?: (fromFile: string, toModule: string) => void;
  /** Open the cross-workspace map (all open workspaces and their imports). */
  onOpenWorkspacesMap?: () => void;
  /**
   * External "zoom into this module (and file)" request — expands in place.
   * A module without a diagram node yet is added (code-linked) and expanded,
   * so every module the code map knows is reachable on this canvas.
   * `module` may be empty when only a file is known — it's derived from the map.
   */
  expandRequest?: { module: string; file?: string; nonce: number } | null;
  /** External "point at this node" request (trace/flamegraph clicks) — selects, pans, pulses. */
  highlightRequest?: { nodeId: string; nonce: number } | null;
  showDuplicates?: boolean;
  onToggleDuplicates?: (on: boolean) => void;
  showFindings?: boolean;
  onToggleFindings?: (on: boolean) => void;
}

const GHOST_STROKE = "var(--color-crystal-400)";
const FLOW_STROKE = "var(--color-crystal-400)";
/** Hover lens: what the hovered node uses (imports) vs what uses it (exports). */
const HOVER_OUT_STROKE = "var(--color-accent-cyan)";
const HOVER_IN_STROKE = "var(--color-accent-emerald)";

/**
 * Dynamic level-of-detail. Detail grows continuously with zoom rather than at
 * a global cliff: every candidate gets its own expand threshold — a base zoom
 * plus a penalty for its distance from the viewport center — so nodes open one
 * by one as you keep zooming (center of attention first), instead of everything
 * in view ballooning at once. Each auto-expansion remembers the threshold it
 * fired at and folds up individually once zoom drops a fixed hysteresis below
 * it, which staggers the collapse the same way.
 *
 * Detail also *leaves*: auto-expansions fold when they scroll out of view, and
 * hard ceilings bound how many stay open at once, so a long zoomed-in session
 * reads like a spotlight instead of accreting symbol soup. Manual expansions
 * are the user's own focus statement — they don't count against ceilings, are
 * never auto-folded, and folding everything LOD opened elsewhere when one is
 * made keeps the working area readable.
 *
 * The base expand thresholds are not fixed zooms: they derive from the
 * configurable legibility knob (`lod-config.ts`) — detail expands in once its
 * words would render comfortably above the minimum on-screen text height.
 */
/** Extra zoom required at the viewport corner vs its center. */
const LOD_STAGGER = 0.45;
/** Auto-expansions collapse this far below the zoom that opened them. */
const LOD_HYSTERESIS = 0.3;
/** New expansions per evaluation pass — keeps a deep zoom from fetching everything at once. */
const LOD_MODULE_BUDGET = 6;
const LOD_FILE_BUDGET = 16;
/**
 * Ceilings on what LOD keeps open at once. Auto-expansions that scroll out of
 * view fold up (freeing their slot), so detail follows the viewport instead of
 * accreting until the whole canvas is symbol soup. Manual expansions don't
 * count against the ceilings and are never folded.
 */
const LOD_MAX_AUTO_MODULES = 4;
const LOD_MAX_AUTO_FILES = 24;

/** Journey lens: highlight + number edges on the flow, dim the rest. */
function applyFlowToEdges(edges: ArchRfEdge[], flow: FlowProjection): ArchRfEdge[] {
  const decorated = edges.map((e): ArchRfEdge => {
    const steps = flow.edgeSteps.get(e.id);
    if (!steps) return { ...e, style: { ...e.style, opacity: 0.15 }, label: undefined };
    return {
      ...e,
      animated: true,
      label: steps.join(" · "),
      style: { ...e.style, stroke: FLOW_STROKE, strokeWidth: 2.4, strokeDasharray: undefined, opacity: 1 },
      labelStyle: { fill: FLOW_STROKE, fontSize: 10, fontWeight: 700 },
      labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.95 },
      markerEnd: { type: MarkerType.ArrowClosed, color: FLOW_STROKE, width: 18, height: 18 },
    };
  });
  for (const hop of flow.ghostHops) {
    decorated.push({
      id: `flow:${hop.step}`,
      source: hop.source,
      target: hop.target,
      type: "default",
      animated: true,
      selectable: false,
      deletable: false,
      focusable: false,
      data: { kind: "data" },
      label: String(hop.step),
      style: { stroke: FLOW_STROKE, strokeWidth: 2, strokeDasharray: "5 4", opacity: 0.9 },
      labelStyle: { fill: FLOW_STROKE, fontSize: 10, fontWeight: 700 },
      labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.95 },
      markerEnd: { type: MarkerType.ArrowClosed, color: FLOW_STROKE, width: 18, height: 18 },
    });
  }
  return decorated;
}

/** Recolor drawn edges by overlay verdict and append dashed ghost edges. */
function applyOverlayToEdges(edges: ArchRfEdge[], overlay: OverlayResult): ArchRfEdge[] {
  const decorated = edges.map((e) => {
    if (overlay.confirmedEdgeIds.has(e.id)) {
      return {
        ...e,
        style: { ...e.style, stroke: "var(--color-ok)", strokeWidth: 2, opacity: 1 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-ok)", width: 16, height: 16 },
      };
    }
    if (overlay.staleEdgeIds.has(e.id)) {
      return {
        ...e,
        label: e.label ?? "not in code",
        style: { ...e.style, stroke: "var(--color-warn)", strokeDasharray: "3 4", opacity: 0.8 },
        labelStyle: { fill: "var(--color-warn)", fontSize: 9 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-warn)", width: 14, height: 14 },
      };
    }
    return e;
  });
  for (const ghost of overlay.ghostEdges) {
    decorated.push({
      id: `ghost:${ghost.sourceModule}->${ghost.targetModule}`,
      source: ghost.source,
      target: ghost.target,
      type: "default",
      animated: true,
      selectable: false,
      deletable: false,
      focusable: false,
      data: { kind: "dependency" },
      label: ghost.weight > 1 ? `code ×${ghost.weight}` : "code",
      style: { stroke: GHOST_STROKE, strokeWidth: 1.3, strokeDasharray: "5 4", opacity: 0.75 },
      labelStyle: { fill: GHOST_STROKE, fontSize: 9 },
      labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      markerEnd: { type: MarkerType.ArrowClosed, color: GHOST_STROKE, width: 14, height: 14 },
    });
  }
  return decorated;
}

type MenuState =
  | { kind: "pane"; x: number; y: number; flowPos: { x: number; y: number } }
  | { kind: "node"; x: number; y: number; id: string }
  | { kind: "edge"; x: number; y: number; id: string }
  | { kind: "codefile"; x: number; y: number; data: FileNodeData }
  | { kind: "codesymbol"; x: number; y: number; data: SymbolNodeData };

interface CacheEntry<T> {
  gen: number;
  detail: T;
}

const NO_MOVES: MoveLikeIntent[] = [];

function CanvasInner({
  graph,
  onChange,
  codeSummary,
  overlayOn,
  onToggleOverlay,
  draftMode,
  flow,
  moves = NO_MOVES,
  onStartJourney,
  onRecordMove,
  onRecordFileMove,
  onOpenWorkspacesMap,
  expandRequest,
  highlightRequest,
  showDuplicates,
  onToggleDuplicates,
  showFindings,
  onToggleFindings,
}: ArchitectCanvasProps) {
  const [selectedNodes, setSelectedNodes] = useState<ReadonlySet<string>>(new Set());
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(new Set());
  /** Node under the cursor — its imports/exports light up, the rest recedes. */
  const [hovered, setHovered] = useState<string | null>(null);
  /** Node pulsing after an external reveal (trace/flamegraph click). */
  const [flashId, setFlashId] = useState<string | null>(null);
  const [defaultEdgeKind, setDefaultEdgeKind] = useState<ArchEdgeKind>("sync");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<{ x: number; y: number; id: string } | null>(null);
  const [peek, setPeek] = useState<{ module: string; label: string; file?: string } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, fitView, getNodes, getViewport } = useReactFlow();

  // Keep a ref of the latest graph so stale-closure callbacks always mutate fresh state.
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const commit = useCallback(
    (next: ArchitectureGraph) => {
      graphRef.current = next;
      onChange(next);
    },
    [onChange],
  );

  /* ---------------- facets: named lenses over the same diagram ---------------- */

  const nav = useNavUpdate();
  const activeFacetId = useNav((l) => l.architect?.facet) ?? null;
  const activeFacet = useMemo(
    () => graph.facets.find((f) => f.id === activeFacetId) ?? null,
    [graph, activeFacetId],
  );
  /**
   * What the canvas renders: the active facet's slice of the graph. All
   * mutations still commit against the full graph — a facet only filters,
   * geometry and content stay shared with every other facet.
   */
  const viewGraph = useMemo(
    () => (activeFacet ? filterGraphToFacet(graph, activeFacet) : graph),
    [graph, activeFacet],
  );

  const updateFacetMembers = useCallback(
    (facetId: string, mutate: (nodeIds: readonly string[]) => string[]) => {
      const g = graphRef.current;
      commit({
        ...g,
        facets: g.facets.map((f) => (f.id === facetId ? { ...f, nodeIds: mutate(f.nodeIds) } : f)),
      });
    },
    [commit],
  );

  /** New nodes join the active facet — otherwise they'd be born invisible. */
  const adoptIntoActiveFacet = useCallback(
    (g: ArchitectureGraph, nodeId: string): ArchitectureGraph => {
      const facet = g.facets.find((f) => f.id === activeFacetId);
      // An empty facet still shows everything; adopting the first member
      // would suddenly hide the rest of the diagram mid-edit.
      if (!facet || facet.nodeIds.length === 0) return g;
      return {
        ...g,
        facets: g.facets.map((f) =>
          f.id === facet.id ? { ...f, nodeIds: [...f.nodeIds, nodeId] } : f,
        ),
      };
    },
    [activeFacetId],
  );

  /* ---------------- live code expansion (the unified "zoom in") ---------------- */

  const { client } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);

  /** Diagram node id → module path currently expanded into live code. */
  const [codeExpanded, setCodeExpanded] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [openCode, setOpenCode] = useState<ReadonlySet<string>>(() => new Set());
  /** Diagram nodes showing every file despite the per-module cap. */
  const [showAllFiles, setShowAllFiles] = useState<ReadonlySet<string>>(() => new Set());
  /** In-flight drag positions for code children (they snap back on drop). */
  const [dragOverrides, setDragOverrides] = useState<ReadonlyMap<string, { x: number; y: number }>>(
    () => new Map(),
  );
  const [generation, setGeneration] = useState(0);
  const [moduleDetails, setModuleDetails] = useState<Map<string, CacheEntry<CodeModuleDetail>>>(
    () => new Map(),
  );
  const [fileDetails, setFileDetails] = useState<Map<string, CacheEntry<CodeFileDetail>>>(
    () => new Map(),
  );
  const inflight = useRef(new Set<string>());

  /** Zoom-driven LOD: what the engine expanded on its own (and may collapse again). */
  const [lodOn, setLodOn] = useState(true);
  const lodOnRef = useRef(lodOn);
  lodOnRef.current = lodOn;
  // Expand thresholds derive from the legibility knob: detail opens once its
  // words would render comfortably above the minimum on-screen text height.
  const minTextPx = useLodConfig((s) => s.minTextPx);
  const lodModuleZoom = moduleExpandZoom(minTextPx);
  const lodFileZoom = fileExpandZoom(minTextPx);
  /** id/path → the staggered threshold the expansion fired at (its collapse anchor). */
  const autoExpandedNodes = useRef(new Map<string, number>());
  const autoExpandedFiles = useRef(new Map<string, number>());
  /** Manually collapsed while zoomed in — LOD leaves these alone until the next zoom-out. */
  const lodSuppressedNodes = useRef(new Set<string>());
  const lodSuppressedFiles = useRef(new Set<string>());
  const expandedRef = useRef<ReadonlyMap<string, string>>(new Map());
  const expandedFilesRef = useRef<ReadonlySet<string>>(new Set());
  expandedFilesRef.current = expandedFiles;

  // The server re-analyzes when code changes on disk — refresh expanded content.
  useEffect(
    () =>
      client.events.on("codemap.changed", ({ ws }) => {
        if (!activeWs || ws === activeWs) setGeneration((g) => g + 1);
      }),
    [client, activeWs],
  );

  // Only nodes that still exist (and the facet shows) expand; a deleted or
  // hidden node drops its code children.
  const expanded = useMemo(() => {
    const ids = new Set(viewGraph.nodes.map((n) => n.id));
    const m = new Map<string, string>();
    for (const [id, module] of codeExpanded) if (ids.has(id)) m.set(id, module);
    return m as ReadonlyMap<string, string>;
  }, [codeExpanded, viewGraph]);
  expandedRef.current = expanded;

  useEffect(() => {
    for (const path of expandedFiles) {
      if (fileDetails.get(path)?.gen === generation) continue;
      const key = `f|${path}|${generation}`;
      if (inflight.current.has(key)) continue;
      inflight.current.add(key);
      client
        .request("codemap.file", { path })
        .then((detail) => setFileDetails((m) => new Map(m).set(path, { gen: generation, detail })))
        .catch(() => {})
        .finally(() => inflight.current.delete(key));
    }
  }, [client, expandedFiles, generation, fileDetails]);

  const moduleDetailMap = useMemo(() => {
    const m = new Map<string, CodeModuleDetail>();
    for (const [k, v] of moduleDetails) m.set(k, v.detail);
    return m;
  }, [moduleDetails]);
  const fileDetailMap = useMemo(() => {
    const m = new Map<string, CodeFileDetail>();
    for (const [k, v] of fileDetails) m.set(k, v.detail);
    return m;
  }, [fileDetails]);

  const codeContent = useMemo(
    () =>
      buildCodeContent({
        expanded,
        moduleDetails: moduleDetailMap,
        fileDetails: fileDetailMap,
        expandedFiles,
        openCode,
        moves,
        showAllFiles,
      }),
    [expanded, moduleDetailMap, fileDetailMap, expandedFiles, openCode, moves, showAllFiles],
  );

  const toggleAllFiles = useCallback((nodeId: string) => {
    setShowAllFiles((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const toggleFile = useCallback((path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        // Collapsing something LOD opened is an override — don't reopen it.
        if (autoExpandedFiles.current.delete(path)) lodSuppressedFiles.current.add(path);
        next.delete(path);
      } else {
        lodSuppressedFiles.current.delete(path);
        next.add(path);
      }
      return next;
    });
  }, []);
  const toggleCode = useCallback((file: string, symbol: string) => {
    setOpenCode((prev) => {
      const next = new Set(prev);
      const key = codeKey(file, symbol);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const scheduleFocus = useCallback(
    (id: string) => {
      setTimeout(() => {
        void fitView({ nodes: [{ id }], padding: 0.3, duration: 350, maxZoom: 1.15 });
      }, 80);
    },
    [fitView],
  );

  /** Jump the canvas (and the side pane) to another node. */
  const focusNode = useCallback(
    (id: string) => {
      setSelectedNodes(new Set([id]));
      setSelectedEdges(new Set());
      void fitView({ nodes: [{ id }], padding: 0.35, duration: 300, maxZoom: 1 });
    },
    [fitView],
  );

  /* ---------------- overlay + scene ---------------- */

  const overlay = useMemo(
    () => (overlayOn && codeSummary ? computeOverlay(viewGraph, codeSummary) : null),
    [overlayOn, codeSummary, viewGraph],
  );

  /** Module a node maps to: explicit link, then overlay match, then name match. */
  const moduleForNode = useCallback(
    (id: string): string | null => {
      const fromExpansion = expanded.get(id);
      if (fromExpansion) return fromExpansion;
      const node = graphRef.current.nodes.find((n) => n.id === id);
      if (!node || node.kind === "note") return null;
      if (node.codeModule) return node.codeModule;
      const badge = overlay?.nodeBadges.get(id);
      if (badge) return badge.module;
      if (codeSummary) return suggestModuleFor(node, codeSummary.modules)?.path ?? null;
      return null;
    },
    [expanded, overlay, codeSummary],
  );

  /**
   * Code anchor of a node: file-linked nodes (legacy "Expand code") resolve to
   * their file plus its owning module; everything else falls back to the
   * module link.
   */
  const codeRefForNode = useCallback(
    (id: string): { module: string; file?: string } | null => {
      const g = graphRef.current;
      const node = g.nodes.find((n) => n.id === id);
      if (!node || node.kind === "note") return null;
      if (node.codeFile) {
        const file = node.codeFile;
        let parent = node.parentId ? g.nodes.find((n) => n.id === node.parentId) : undefined;
        while (parent && !parent.codeModule) {
          parent = parent.parentId ? g.nodes.find((n) => n.id === parent!.parentId) : undefined;
        }
        const byPrefix = codeSummary?.modules
          .filter((m) => m.path !== "." && file.startsWith(`${m.path}/`))
          .sort((a, b) => b.path.length - a.path.length)[0]?.path;
        const module =
          parent?.codeModule ??
          byPrefix ??
          (codeSummary?.modules.some((m) => m.path === ".") ? "." : null);
        return module ? { module, file } : null;
      }
      const module = moduleForNode(id);
      return module ? { module } : null;
    },
    [moduleForNode, codeSummary],
  );

  /* ---------------- cross-view highlight ---------------- */

  const {
    hover: extHover,
    hoverSource,
    pinned,
    setHover: publishHover,
    pin,
  } = useViewHighlight("canvas");

  /** Structured cross-view identity of a diagram node (see use-highlight.ts). */
  const hlRefFor = useCallback(
    (id: string): HighlightRef => {
      const g = graphRef.current;
      const node = g.nodes.find((n) => n.id === id);
      const ref = codeRefForNode(id);
      const chain = ancestorsOf(g, id).map((n) => n.id);
      return {
        node: id,
        nodePath: chain.length ? chain : undefined,
        module: ref?.module,
        file: ref?.file,
        label: node?.label,
      };
    },
    [codeRefForNode],
  );

  /** Identity of an ephemeral live-code child (file card / symbol chip). */
  const hlRefForChild = useCallback((data: Partial<MapNodeData>): HighlightRef | null => {
    if (data.nodeKind === "file" && data.path)
      return { file: data.path, module: data.module, label: data.name };
    if (data.nodeKind === "symbol" && data.file && data.name)
      return { file: data.file, symbol: data.name, module: data.module, label: data.name };
    return null;
  }, []);

  /**
   * Reserved LOD footprints: every code-linked node renders collapsed at the
   * size its module-level expansion needs (`estimateModuleFootprint` always
   * contains the real packing). Level of detail then swaps content inside a
   * fixed box — nothing moves, nothing reflows, no empty reserved gaps.
   */
  const slots = useMemo(() => {
    const sizes = new Map<string, { width: number; height: number }>();
    const modules = new Map<string, string>();
    if (!codeSummary) return { sizes, modules };
    const fileCounts = new Map(codeSummary.modules.map((mod) => [mod.path, mod.fileCount]));
    // The full graph, not the facet's slice — auto-layout must reserve for
    // hidden nodes too, or leaving a facet would land on overlaps.
    for (const n of graph.nodes) {
      if (isContainerKind(n.kind) || n.kind === "note" || n.codeFile) continue;
      const module = moduleForNode(n.id);
      const count = module ? fileCounts.get(module) : undefined;
      if (module && count) {
        sizes.set(n.id, estimateModuleFootprint(count));
        modules.set(n.id, module);
      }
    }
    return { sizes, modules };
  }, [graph, codeSummary, moduleForNode]);
  const slotSizes = slots.sizes;

  /**
   * Every slotted block previews its module's files at medium zoom, so module
   * details are fetched for all of them, not only the expanded ones. This also
   * pre-warms the cache LOD expansion reads from — zooming in swaps content
   * that is usually already there.
   */
  const neededModules = useMemo(
    () => new Set([...expanded.values(), ...slots.modules.values()]),
    [expanded, slots],
  );

  useEffect(() => {
    for (const module of neededModules) {
      if (moduleDetails.get(module)?.gen === generation) continue;
      const key = `m|${module}|${generation}`;
      if (inflight.current.has(key)) continue;
      inflight.current.add(key);
      client
        .request("codemap.module", { path: module })
        .then((detail) => setModuleDetails((m) => new Map(m).set(module, { gen: generation, detail })))
        .catch(() => {})
        .finally(() => inflight.current.delete(key));
    }
  }, [client, neededModules, generation, moduleDetails]);

  const blockPreviews = useMemo(() => {
    const byModule = new Map<string, BlockPreview>();
    const m = new Map<string, BlockPreview>();
    for (const [nodeId, module] of slots.modules) {
      if (expanded.has(nodeId)) continue; // showing the real content instead
      let preview = byModule.get(module);
      if (!preview) {
        const detail = moduleDetailMap.get(module);
        if (!detail) continue;
        preview = buildBlockPreview(detail);
        byModule.set(module, preview);
      }
      m.set(nodeId, preview);
    }
    return m;
  }, [slots, moduleDetailMap, expanded]);

  /* ---------------- hover lens: imports and exports of one node ---------------- */

  const [dragActive, setDragActive] = useState(false);

  /**
   * Ids to keep lit while `hovered` is set: the node itself plus everything it
   * connects to — drawn edges, code-only ghost edges, and live-code import
   * edges all count. Edge direction is reported separately (outgoing = what it
   * uses, incoming = what uses it) by the edge decoration.
   */
  const hoverNeighborhood = useMemo(() => {
    if (!hovered) return null;
    const nodes = new Set<string>([hovered]);
    const consider = (src: string, tgt: string) => {
      if (src === hovered) nodes.add(tgt);
      else if (tgt === hovered) nodes.add(src);
    };
    for (const e of viewGraph.edges) consider(e.source, e.target);
    if (overlay) for (const g of overlay.ghostEdges) consider(g.source, g.target);
    for (const e of codeContent.edges) consider(e.source, e.target);
    return nodes;
  }, [hovered, viewGraph, overlay, codeContent]);

  // A short dwell before the spotlight engages — sweeping the cursor across
  // the canvas shouldn't strobe the whole diagram. The same dwell publishes
  // the hover to the cross-view highlight store, so the flamegraph, journey
  // steps and code map light up whatever the cursor rests on here.
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onNodeMouseEnter = useCallback(
    (_evt: unknown, node: RfNode) => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      if (dragActive) return;
      hoverTimer.current = setTimeout(() => {
        setHovered(node.id);
        publishHover(
          isCodeChildId(node.id)
            ? hlRefForChild(node.data as Partial<MapNodeData>)
            : hlRefFor(node.id),
        );
      }, 180);
    },
    [dragActive, publishHover, hlRefFor, hlRefForChild],
  );
  const onNodeMouseLeave = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHovered(null);
    publishHover(null);
  }, [publishHover]);
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );

  /* --------------- ephemeral push-aside for expanded containers --------------- */

  const displaceRef = useRef<ReadonlyMap<string, { dx: number; dy: number }>>(new Map());
  // Expanded content that outgrows its layout slot pushes same-scope siblings
  // aside — view-only offsets, frozen while a drag is in flight (the drag
  // handler subtracts them so the graph keeps base positions).
  const displacements = useMemo(() => {
    if (dragActive) return displaceRef.current;
    if (expanded.size === 0) {
      displaceRef.current = new Map();
      return displaceRef.current;
    }
    const scopes = new Set<string | null>();
    for (const id of expanded.keys()) {
      const n = viewGraph.nodes.find((x) => x.id === id);
      if (n) scopes.add(n.parentId ?? null);
    }
    const out = new Map<string, { dx: number; dy: number }>();
    for (const scope of scopes) {
      const members = viewGraph.nodes.filter((n) => (n.parentId ?? null) === scope);
      const rects: DisplaceRect[] = members.map((n) => {
        // Rendered footprint: expanded content and the reserved slot cover the
        // same box by construction, so expansion usually displaces nothing.
        const content = expanded.has(n.id) ? codeContent.sizes.get(n.id) : undefined;
        const slot = slotSizes.get(n.id);
        const width =
          Math.max(content?.width ?? 0, slot?.width ?? 0) ||
          (isContainerKind(n.kind) ? (n.size?.width ?? 420) : 200);
        const height =
          Math.max(content?.height ?? 0, slot?.height ?? 0) ||
          (isContainerKind(n.kind) ? (n.size?.height ?? 280) : 84);
        return {
          id: n.id,
          x: n.position.x,
          y: n.position.y,
          width,
          height,
          fixed: expanded.has(n.id),
        };
      });
      for (const [id, off] of resolveCollisions(rects)) out.set(id, off);
    }
    displaceRef.current = out;
    return out;
  }, [expanded, codeContent, viewGraph, slotSizes, dragActive]);

  /** Cross-view identity per diagram node, stamped into node data (DOM attrs). */
  const nodeHlRefs = useMemo(() => {
    const m = new Map<string, HighlightRef>();
    for (const n of viewGraph.nodes) m.set(n.id, hlRefFor(n.id));
    return m;
  }, [viewGraph, hlRefFor]);

  /** Hover published by another surface — this canvas echoes its own via the lens. */
  const externalHover = hoverSource !== "canvas" ? extHover : null;

  const rfNodes = useMemo<CanvasNode[]>(() => {
    let nodes: CanvasNode[] = toRfNodes(viewGraph, selectedNodes, slotSizes).map((n) => {
      const hlRef = nodeHlRefs.get(n.id);
      return hlRef ? ({ ...n, data: { ...n.data, hlRef } } as ArchRfNode) : n;
    });
    if (overlay) {
      nodes = nodes.map((n) => {
        const code = overlay.nodeBadges.get(n.id);
        return code ? ({ ...n, data: { ...n.data, code } } as ArchRfNode) : n;
      });
    }
    if (blockPreviews.size > 0) {
      nodes = nodes.map((n) => {
        const preview = blockPreviews.get(n.id);
        return preview ? ({ ...n, data: { ...n.data, preview } } as ArchRfNode) : n;
      });
    }
    if (flow) {
      const stepOf = new Map(flow.nodeOrder.map((o) => [o.nodeId, o.firstStep]));
      nodes = nodes.map(
        (n) =>
          ({
            ...n,
            data: { ...n.data, flow: { step: stepOf.get(n.id) ?? null } },
          }) as ArchRfNode,
      );
    }
    if (expanded.size > 0) {
      // Expanded nodes render as containers holding their live code. The box
      // never shrinks below the reserved slot, so expand/collapse swaps what's
      // inside without changing the diagram's geometry.
      nodes = nodes.map((n) => {
        if (!expanded.has(n.id)) return n;
        const content = codeContent.sizes.get(n.id);
        const slot = slotSizes.get(n.id);
        const width = Math.max(content?.width ?? 0, slot?.width ?? 0);
        const height = Math.max(content?.height ?? 0, slot?.height ?? 0);
        return {
          ...n,
          type: "container",
          width: width || undefined,
          height: height || undefined,
          zIndex: -1,
          className: "lod-grow",
          dragHandle: ".arch-container-header",
          data: {
            ...n.data,
            codeExpanded: true,
            codeLoading: codeContent.loading.has(n.id),
          },
        } as ArchRfNode;
      });
      const kids = codeContent.nodes.map((k) => {
        const o = dragOverrides.get(k.id);
        return o ? { ...k, position: o } : k;
      });
      nodes = [...nodes, ...kids];
    }
    if (displacements.size > 0) {
      nodes = nodes.map((n) => {
        const off = displacements.get(n.id);
        if (!off) return n;
        return {
          ...n,
          position: { x: n.position.x + off.dx, y: n.position.y + off.dy },
          className: cn(n.className, !dragActive && "arch-displaced"),
        } as CanvasNode;
      });
    }
    if (flashId) {
      nodes = nodes.map((n) =>
        n.id === flashId ? ({ ...n, className: cn(n.className, "arch-flash") } as CanvasNode) : n,
      );
    }
    if (hoverNeighborhood) {
      // Spotlight the hovered node's import/export neighborhood by lifting it,
      // not by receding everything else: the node under the cursor gets the
      // strongest emphasis, its connected kin a softer one, and the rest of
      // the diagram stays exactly as it was.
      const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]));
      const lit = (id: string): boolean => {
        let cur: string | undefined = id;
        while (cur) {
          if (hoverNeighborhood.has(cur)) return true;
          cur = parentOf.get(cur) ?? undefined;
        }
        return false;
      };
      nodes = nodes.map((n) => {
        if (!lit(n.id)) return n;
        const cls = n.id === hovered ? "arch-hover-focus" : "arch-hover-near";
        return { ...n, className: cn(n.className, cls) } as CanvasNode;
      });
    }
    if (externalHover || pinned) {
      // Cross-view highlight: ring whatever matches the hover published by
      // another surface (flamegraph frame, journey step, code-map chip) or
      // the deep-linked pinned selection. Kin = same lineage, softer ring.
      nodes = nodes.map((n) => {
        const el =
          (n.data as { hlRef?: HighlightRef }).hlRef ??
          hlRefForChild(n.data as Partial<MapNodeData>);
        if (!el) return n;
        const cls = hlClass(matchHighlight(externalHover, el), matchHighlight(pinned, el));
        return cls ? ({ ...n, className: cn(n.className, cls) } as CanvasNode) : n;
      });
    }
    return nodes;
  }, [viewGraph, selectedNodes, slotSizes, overlay, blockPreviews, flow, expanded, codeContent, dragOverrides, displacements, dragActive, hoverNeighborhood, hovered, flashId, nodeHlRefs, externalHover, pinned, hlRefForChild]);

  const rfEdges = useMemo(() => {
    let edges = [...toRfEdges(viewGraph, selectedEdges), ...(codeContent.edges as ArchRfEdge[])];
    if (overlay) edges = applyOverlayToEdges(edges, overlay);
    if (flow) edges = applyFlowToEdges(edges, flow);
    if (hovered) {
      // Direction is the information: cyan = the hovered node imports/uses
      // this, emerald = this imports/uses the hovered node.
      edges = edges.map((e) => {
        if (e.source !== hovered && e.target !== hovered) {
          return e;
        }
        const color = e.source === hovered ? HOVER_OUT_STROKE : HOVER_IN_STROKE;
        return {
          ...e,
          style: { ...e.style, stroke: color, strokeDasharray: undefined, strokeWidth: 2.2, opacity: 1 },
          labelStyle: { fill: color, fontSize: 10, fontWeight: 600 },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
          zIndex: 5,
        };
      });
    }
    return edges;
  }, [viewGraph, selectedEdges, overlay, flow, codeContent, hovered]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      let g = graphRef.current;
      let selection: Set<string> | null = null;
      let overrides: Map<string, { x: number; y: number }> | null = null;
      for (const change of changes) {
        switch (change.type) {
          case "position": {
            if (!change.position) break;
            if (isCodeChildId(change.id)) {
              overrides ??= new Map(dragOverrides);
              overrides.set(change.id, change.position);
              break;
            }
            // Rendered = base + ephemeral displacement; store base so the node
            // stays under the cursor now and slides home on collapse.
            const off = displaceRef.current.get(change.id);
            g = updateNode(g, change.id, {
              position: {
                x: change.position.x - (off?.dx ?? 0),
                y: change.position.y - (off?.dy ?? 0),
              },
            });
            break;
          }
          case "dimensions": {
            const node = g.nodes.find((n) => n.id === change.id);
            if (node && isContainerKind(node.kind) && change.dimensions && change.resizing) {
              g = updateNode(g, change.id, {
                size: { width: change.dimensions.width, height: change.dimensions.height },
              });
            }
            break;
          }
          case "select": {
            selection ??= new Set(selectedNodes);
            if (change.selected) selection.add(change.id);
            else selection.delete(change.id);
            break;
          }
          case "remove":
            if (!isCodeChildId(change.id)) g = deleteNodes(g, [change.id]);
            break;
          default:
            break;
        }
      }
      if (overrides) setDragOverrides(overrides);
      if (selection) setSelectedNodes(selection);
      if (g !== graphRef.current) commit(g);
    },
    [commit, selectedNodes, dragOverrides],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<ArchRfEdge>[]) => {
      let g = graphRef.current;
      let selection: Set<string> | null = null;
      for (const change of changes) {
        if (change.type === "select") {
          selection ??= new Set(selectedEdges);
          if (change.selected) selection.add(change.id);
          else selection.delete(change.id);
        } else if (change.type === "remove") {
          g = deleteEdges(g, [change.id]);
        }
      }
      if (selection) setSelectedEdges(selection);
      if (g !== graphRef.current) commit(g);
    },
    [commit, selectedEdges],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (isCodeChildId(connection.source) || isCodeChildId(connection.target)) return;
      commit(opAddEdge(graphRef.current, connection.source, connection.target, defaultEdgeKind));
    },
    [commit, defaultEdgeKind],
  );

  /**
   * Best file to open in the editor for a node: its own file link, else the
   * linked module's entry point (index.*), else its most exported file.
   */
  const editorFileForNode = useCallback(
    (id: string): string | null => {
      const ref = codeRefForNode(id);
      if (!ref) return null;
      if (ref.file) return ref.file;
      const detail = moduleDetailMap.get(ref.module);
      if (!detail || detail.files.length === 0) return null;
      const entry = detail.files.find((f) => !f.dir && /^index\.[cm]?[jt]sx?$/.test(f.name));
      const top = [...detail.files].sort((a, b) => b.exportCount - a.exportCount)[0]!;
      return (entry ?? top).path;
    },
    [codeRefForNode, moduleDetailMap],
  );

  /** Expand/collapse a diagram node into its module's live code. */
  const toggleNodeCode = useCallback(
    (id: string) => {
      if (codeExpanded.has(id)) {
        // Collapsing something LOD opened is an override — don't reopen it.
        if (autoExpandedNodes.current.delete(id)) lodSuppressedNodes.current.add(id);
        setCodeExpanded((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
        return;
      }
      const node = graphRef.current.nodes.find((n) => n.id === id);
      if (!node || node.kind === "note" || isContainerKind(node.kind)) return;
      const module = moduleForNode(id);
      if (!module) return;
      lodSuppressedNodes.current.delete(id);
      // Expanding by hand signals focus: fold what LOD opened elsewhere so the
      // canvas stays readable around the node being worked on. Other manual
      // expansions stay — cross-module refactors need several open at once.
      const autoOthers = [...autoExpandedNodes.current.keys()].filter((k) => k !== id);
      for (const k of autoOthers) {
        autoExpandedNodes.current.delete(k);
        lodSuppressedNodes.current.add(k);
      }
      setCodeExpanded((prev) => {
        const next = new Map(prev);
        for (const k of autoOthers) next.delete(k);
        return next.set(id, module);
      });
      scheduleFocus(id);
    },
    [codeExpanded, moduleForNode, scheduleFocus],
  );

  // External drill requests ("zoom into this module/file") expand in place.
  // A module with no diagram node yet gets one added (code-linked) below the
  // current content — the canvas is the map, so nothing is unreachable.
  const expandNonce = useRef(0);
  useEffect(() => {
    if (!expandRequest || expandRequest.nonce === expandNonce.current) return;
    const { file } = expandRequest;
    const module =
      expandRequest.module ||
      (file && codeSummary ? moduleOfPath(file, codeSummary.modules) : "");
    const g = graphRef.current;
    const target = module
      ? (g.nodes.find(
          (n) => n.codeModule === module && !isContainerKind(n.kind) && n.kind !== "note",
        ) ??
        g.nodes.find(
          (n) =>
            !isContainerKind(n.kind) && n.kind !== "note" && !n.codeFile && moduleForNode(n.id) === module,
        ))
      : undefined;
    if (!target) {
      // Adding the missing module node needs the code map — a request that
      // arrives before the summary waits (nonce unconsumed, deps re-fire).
      if (!codeSummary) return;
      expandNonce.current = expandRequest.nonce;
      const info = codeSummary.modules.find((m) => m.path === module);
      if (!info) return;
      let bottom = 0;
      for (const n of g.nodes) {
        if (n.parentId) continue;
        bottom = Math.max(bottom, n.position.y + (n.size?.height ?? 120));
      }
      const { graph: next, node } = opAddNode(
        g,
        archKindForCodeModule(info),
        info.name,
        { x: 0, y: bottom + 80 },
        null,
      );
      commit(adoptIntoActiveFacet(updateNode(next, node.id, { codeModule: module }), node.id));
      setCodeExpanded((prev) => new Map(prev).set(node.id, module));
      if (file) setExpandedFiles((prev) => (prev.has(file) ? prev : new Set(prev).add(file)));
      scheduleFocus(node.id);
      return;
    }
    expandNonce.current = expandRequest.nonce;
    setCodeExpanded((prev) => new Map(prev).set(target.id, module));
    if (file) setExpandedFiles((prev) => (prev.has(file) ? prev : new Set(prev).add(file)));
    scheduleFocus(target.id);
  }, [expandRequest, moduleForNode, codeSummary, commit, adoptIntoActiveFacet, scheduleFocus]);

  /* ---------------- drag / drop ---------------- */

  const onNodeDragStart = useCallback(() => {
    setDragActive(true);
    setHovered(null);
  }, []);

  const onNodeDragStop = useCallback(
    (_evt: unknown, node: RfNode, nodes: RfNode[]) => {
      setDragActive(false);
      if (isCodeChildId(node.id)) {
        // Live code children: a drop on another file/module records a refactor
        // intent; either way the chip snaps back to its derived home.
        const data = node.data as MapNodeData;
        const live = getNodes() as unknown as HitTestNode[];
        const abs = absolutePositionOf(live, node.id);
        const self = live.find((n) => n.id === node.id);
        if (abs && self) {
          const w = self.measured?.width ?? self.width ?? 0;
          const h = self.measured?.height ?? self.height ?? 0;
          const center = { x: abs.x + w / 2, y: abs.y + h / 2 };
          if (data.nodeKind === "symbol" && !data.planned) {
            const target = unifiedDropTargetAt(live, center, { file: data.file, module: data.module }, moduleForNode);
            if (target) onRecordMove?.({ file: data.file, symbol: data.name }, target);
          } else if (data.nodeKind === "file" && !data.planned) {
            const target = unifiedDropTargetAt(live, center, { file: data.path, module: data.module }, moduleForNode);
            if (target && target.module !== data.module) onRecordFileMove?.(data.path, target.module);
          }
        }
        setDragOverrides(new Map());
        return;
      }
      let g = graphRef.current;
      const dragged = (nodes.length ? nodes : [node]).filter((rf) => !isCodeChildId(rf.id));
      for (const rf of dragged) {
        const abs = absolutePosition(g, rf.id);
        const width = rf.measured?.width ?? rf.width ?? 200;
        const height = rf.measured?.height ?? rf.height ?? 80;
        const center = { x: abs.x + width / 2, y: abs.y + height / 2 };
        const container = containerAtPoint(g, center, rf.id);
        const currentParent = g.nodes.find((n) => n.id === rf.id)?.parentId ?? null;
        const nextParent = container?.id ?? null;
        if (nextParent !== currentParent) {
          g = reparentNode(g, rf.id, nextParent, abs);
        }
      }
      if (g !== graphRef.current) commit(g);
    },
    [commit, getNodes, moduleForNode, onRecordMove, onRecordFileMove],
  );

  const addNodeAt = useCallback(
    (kind: ArchNodeKind, flowPos: { x: number; y: number }) => {
      let g = graphRef.current;
      const container = containerAtPoint(g, flowPos, undefined);
      const parentAbs = container ? absolutePosition(g, container.id) : { x: 0, y: 0 };
      const rel = { x: flowPos.x - parentAbs.x, y: flowPos.y - parentAbs.y };
      const { graph: next, node } = opAddNode(
        g,
        kind,
        `New ${KIND_META[kind].label.toLowerCase()}`,
        container ? rel : flowPos,
        container?.id ?? null,
      );
      commit(adoptIntoActiveFacet(next, node.id));
      setSelectedNodes(new Set([node.id]));
      setSelectedEdges(new Set());
    },
    [commit, adoptIntoActiveFacet],
  );

  /** Add a node pre-linked to a code module, expanded into live code. */
  const addModuleNodeAt = useCallback(
    (modulePath: string, moduleName: string, flowPos: { x: number; y: number }) => {
      const { graph: next, node } = opAddNode(graphRef.current, "service", moduleName, flowPos, null);
      commit(adoptIntoActiveFacet(updateNode(next, node.id, { codeModule: modulePath }), node.id));
      setCodeExpanded((prev) => new Map(prev).set(node.id, modulePath));
      setSelectedNodes(new Set([node.id]));
      scheduleFocus(node.id);
    },
    [commit, adoptIntoActiveFacet, scheduleFocus],
  );

  const onDrop = useCallback(
    (evt: DragEvent) => {
      const kind = evt.dataTransfer.getData(DRAG_MIME) as ArchNodeKind;
      if (!kind || !(kind in KIND_META)) return;
      evt.preventDefault();
      addNodeAt(kind, screenToFlowPosition({ x: evt.clientX, y: evt.clientY }));
    },
    [addNodeAt, screenToFlowPosition],
  );

  const addAtViewportCenter = useCallback(
    (kind: ArchNodeKind) => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      const point = rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      addNodeAt(kind, screenToFlowPosition(point));
    },
    [addNodeAt, screenToFlowPosition],
  );

  /* ---------- explicit detail ladder (unified from the code map) ---------- */

  // Deep-linkable, same `lod` param the code map used: packages → modules → members.
  const lodLevelParam = useNav((l) => l.architect?.lod ?? null);
  const lodLevel: CodeLodLevel =
    lodLevelParam && CANVAS_LOD_LEVELS.includes(lodLevelParam) ? lodLevelParam : "packages";
  const [memberCount, setMemberCount] = useState<number | null>(null);

  /** One discrete stop re-poses the whole canvas; per-node expand/collapse still works on top. */
  const applyLodLevel = useCallback(
    async (level: CodeLodLevel) => {
      // An explicit stop overrides the zoom-driven engine's bookkeeping.
      autoExpandedNodes.current.clear();
      autoExpandedFiles.current.clear();
      lodSuppressedNodes.current.clear();
      lodSuppressedFiles.current.clear();
      if (level === "repos" || level === "packages") {
        setCodeExpanded(new Map());
        setExpandedFiles(new Set());
        setOpenCode(new Set());
        return;
      }
      const adds = new Map<string, string>();
      for (const n of graphRef.current.nodes) {
        if (isContainerKind(n.kind) || n.kind === "note" || n.codeFile) continue;
        const module = moduleForNode(n.id);
        if (module) adds.set(n.id, module);
      }
      setCodeExpanded(adds);
      if (level === "members") {
        try {
          const res = await client.request("codemap.details", {});
          setModuleDetails((m) => {
            const next = new Map(m);
            for (const d of res.modules) next.set(d.module.path, { gen: generation, detail: d });
            return next;
          });
          setFileDetails((m) => {
            const next = new Map(m);
            for (const f of res.files) next.set(f.path, { gen: generation, detail: f });
            return next;
          });
          setMemberCount(res.files.reduce((n, f) => n + (f.symbols ?? f.exports).length, 0));
          setExpandedFiles(new Set(res.files.map((f) => f.path)));
        } catch {
          // Analyzer unavailable — stay at module detail.
        }
      } else {
        setExpandedFiles(new Set());
        setOpenCode(new Set());
      }
    },
    [client, generation, moduleForNode],
  );

  const setLodLevel = useCallback(
    (level: CodeLodLevel) => {
      nav({ architect: { lod: level } });
      void applyLodLevel(level);
    },
    [nav, applyLodLevel],
  );

  // A deep-linked ladder stop applies once the code map is in.
  const lodLevelInit = useRef(false);
  useEffect(() => {
    if (lodLevelInit.current || !codeSummary) return;
    lodLevelInit.current = true;
    if (lodLevel !== "packages") void applyLodLevel(lodLevel);
  }, [codeSummary, lodLevel, applyLodLevel]);

  // Keys 1–3 jump the ladder (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const i = ["1", "2", "3"].indexOf(e.key);
      if (i !== -1 && CANVAS_LOD_LEVELS[i]) setLodLevel(CANVAS_LOD_LEVELS[i]!);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setLodLevel]);

  // Entity counts per ladder stop, for the slider readout.
  const lodCounts = useMemo(() => {
    if (!codeSummary) return undefined;
    const counts: Partial<Record<CodeLodLevel, number>> = {
      packages: codeSummary.modules.filter((m) => m.fileCount > 0).length,
      modules: codeSummary.fileTotal,
    };
    if (memberCount != null) counts.members = memberCount;
    return counts;
  }, [codeSummary, memberCount]);

  /* ------------- dynamic level of detail: zoom in expands, zoom out collapses ------------- */

  /**
   * One LOD pass for a viewport, folds before expansions so freed ceiling
   * slots are reusable within the pass. Collapse: an auto-expansion folds when
   * it leaves the viewport, or once zoom drops the hysteresis below the
   * threshold it opened at — unless it would immediately requalify where it
   * sits now (it drifted toward the center since), in which case its anchor is
   * lowered instead of flickering closed and open again. Expansion: every
   * on-screen candidate whose staggered threshold (base zoom +
   * distance-from-center penalty) the current zoom clears opens up, most
   * central first, within the per-pass budget and the global auto-expansion
   * ceiling. Only automatic expansions are ever collapsed — manual ones stay.
   */
  const evaluateLod = useCallback(
    (vp: Viewport) => {
      if (!lodOnRef.current) return;
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const view = {
        x: -vp.x / vp.zoom,
        y: -vp.y / vp.zoom,
        w: rect.width / vp.zoom,
        h: rect.height / vp.zoom,
      };
      const live = getNodes() as unknown as HitTestNode[];
      const byId = new Map(live.map((n) => [n.id, n]));
      const boundsOf = (n: HitTestNode) => {
        let x = n.position.x;
        let y = n.position.y;
        let cur: HitTestNode | undefined = n;
        while (cur.parentId) {
          cur = byId.get(cur.parentId);
          if (!cur) break;
          x += cur.position.x;
          y += cur.position.y;
        }
        const w = n.measured?.width ?? n.width ?? 200;
        const h = n.measured?.height ?? n.height ?? 84;
        return { x, y, w, h };
      };
      const inView = (b: { x: number; y: number; w: number; h: number }): boolean =>
        b.x < view.x + view.w && b.x + b.w > view.x && b.y < view.y + view.h && b.y + b.h > view.y;
      const thresholdFor = (n: HitTestNode, base: number): number => {
        const b = boundsOf(n);
        const dx = (b.x + b.w / 2 - (view.x + view.w / 2)) / (view.w / 2);
        const dy = (b.y + b.h / 2 - (view.y + view.h / 2)) / (view.h / 2);
        return base + Math.min(Math.hypot(dx, dy), 1) * LOD_STAGGER;
      };

      // Drops first so folded expansions free ceiling slots for this pass.
      const nodeDrops: string[] = [];
      for (const [id, threshold] of autoExpandedNodes.current) {
        const n = byId.get(id);
        // Off-screen (or deleted) auto-expansions fold — detail follows the
        // viewport; panning back re-expands them within the ceiling.
        if (!n || !inView(boundsOf(n))) {
          nodeDrops.push(id);
          continue;
        }
        if (vp.zoom > threshold - LOD_HYSTERESIS) continue;
        const now = thresholdFor(n, lodModuleZoom);
        if (vp.zoom >= now) {
          autoExpandedNodes.current.set(id, now);
          continue;
        }
        nodeDrops.push(id);
      }
      if (nodeDrops.length > 0) {
        for (const id of nodeDrops) autoExpandedNodes.current.delete(id);
        setCodeExpanded((prev) => {
          const next = new Map(prev);
          for (const id of nodeDrops) next.delete(id);
          return next;
        });
      }
      if (vp.zoom <= lodModuleZoom - LOD_HYSTERESIS) lodSuppressedNodes.current.clear();

      const moduleCands: { id: string; threshold: number }[] = [];
      for (const n of live) {
        const data = n.data as Partial<ArchRfNode["data"]>;
        const arch = data.arch;
        if (!arch || data.codeExpanded) continue;
        if (isContainerKind(arch.kind) || arch.kind === "note" || arch.codeFile) continue;
        if (expandedRef.current.has(n.id) || autoExpandedNodes.current.has(n.id)) continue;
        if (lodSuppressedNodes.current.has(n.id)) continue;
        if (!inView(boundsOf(n))) continue;
        const threshold = thresholdFor(n, lodModuleZoom);
        if (vp.zoom >= threshold) moduleCands.push({ id: n.id, threshold });
      }
      moduleCands.sort((a, b) => a.threshold - b.threshold);
      const nodeAdds = new Map<string, string>();
      for (const c of moduleCands) {
        if (nodeAdds.size >= LOD_MODULE_BUDGET) break;
        if (autoExpandedNodes.current.size >= LOD_MAX_AUTO_MODULES) break;
        const module = moduleForNode(c.id);
        if (!module) continue;
        nodeAdds.set(c.id, module);
        autoExpandedNodes.current.set(c.id, c.threshold);
      }
      if (nodeAdds.size > 0) {
        setCodeExpanded((prev) => {
          const next = new Map(prev);
          for (const [id, module] of nodeAdds) next.set(id, module);
          return next;
        });
      }

      // Files: same shape — fold what left the viewport (or whose module
      // folded), then expand within budget and ceiling.
      const fileDrops: string[] = [];
      for (const [path, threshold] of autoExpandedFiles.current) {
        const n = byId.get(fileId(path));
        if (!n || !inView(boundsOf(n))) {
          fileDrops.push(path);
          continue;
        }
        if (vp.zoom > threshold - LOD_HYSTERESIS) continue;
        const now = thresholdFor(n, lodFileZoom);
        if (vp.zoom >= now) {
          autoExpandedFiles.current.set(path, now);
          continue;
        }
        fileDrops.push(path);
      }
      if (fileDrops.length > 0) {
        for (const path of fileDrops) autoExpandedFiles.current.delete(path);
        setExpandedFiles((prev) => {
          const next = new Set(prev);
          for (const path of fileDrops) next.delete(path);
          return next;
        });
      }
      if (vp.zoom <= lodFileZoom - LOD_HYSTERESIS) lodSuppressedFiles.current.clear();

      const fileCands: { path: string; threshold: number }[] = [];
      for (const n of live) {
        const data = n.data as Partial<FileNodeData>;
        if (data.nodeKind !== "file" || data.planned || data.expanded || !data.path) continue;
        const path = data.path;
        if (expandedFilesRef.current.has(path) || autoExpandedFiles.current.has(path)) continue;
        if (lodSuppressedFiles.current.has(path)) continue;
        if (!inView(boundsOf(n))) continue;
        const threshold = thresholdFor(n, lodFileZoom);
        if (vp.zoom >= threshold) fileCands.push({ path, threshold });
      }
      fileCands.sort((a, b) => a.threshold - b.threshold);
      const fileAdds: { path: string; threshold: number }[] = [];
      for (const c of fileCands) {
        if (fileAdds.length >= LOD_FILE_BUDGET) break;
        if (autoExpandedFiles.current.size >= LOD_MAX_AUTO_FILES) break;
        fileAdds.push(c);
        autoExpandedFiles.current.set(c.path, c.threshold);
      }
      if (fileAdds.length > 0) {
        setExpandedFiles((prev) => {
          const next = new Set(prev);
          for (const f of fileAdds) next.add(f.path);
          return next;
        });
      }
    },
    [getNodes, moduleForNode, lodModuleZoom, lodFileZoom],
  );

  // Turning the legibility knob re-judges the current viewport immediately —
  // the slider gives live feedback instead of waiting for the next pan/zoom.
  const lastLodThresholds = useRef({ module: lodModuleZoom, file: lodFileZoom });
  useEffect(() => {
    const last = lastLodThresholds.current;
    if (last.module === lodModuleZoom && last.file === lodFileZoom) return;
    lastLodThresholds.current = { module: lodModuleZoom, file: lodFileZoom };
    evaluateLod(getViewport());
  }, [lodModuleZoom, lodFileZoom, evaluateLod, getViewport]);

  // Evaluate while the gesture is in flight (rAF-throttled, and only once the
  // viewport has moved meaningfully), so detail appears as you zoom, not after.
  const lodFrame = useRef<number | null>(null);
  const lastLodVp = useRef<Viewport | null>(null);
  const onMove = useCallback(
    (_evt: unknown, vp: Viewport) => {
      if (!lodOnRef.current) return;
      const last = lastLodVp.current;
      if (
        last &&
        Math.abs(vp.zoom - last.zoom) < 0.02 &&
        Math.abs(vp.x - last.x) < 120 &&
        Math.abs(vp.y - last.y) < 120
      ) {
        return;
      }
      if (lodFrame.current != null) return;
      lodFrame.current = requestAnimationFrame(() => {
        lodFrame.current = null;
        lastLodVp.current = vp;
        evaluateLod(vp);
      });
    },
    [evaluateLod],
  );
  useEffect(
    () => () => {
      if (lodFrame.current != null) cancelAnimationFrame(lodFrame.current);
    },
    [],
  );

  // A diagram can open already zoomed in (persisted viewport) — run one pass
  // once the initial nodes have been measured.
  const lodInitDone = useRef(false);
  useEffect(() => {
    if (lodInitDone.current) return;
    const timer = setTimeout(() => {
      lodInitDone.current = true;
      const vp = graphRef.current.viewport;
      if (vp) evaluateLod(vp);
    }, 250);
    return () => clearTimeout(timer);
  }, [evaluateLod]);

  const toggleLod = useCallback(
    (on: boolean) => {
      lodOnRef.current = on;
      setLodOn(on);
      if (on) evaluateLod(getViewport());
    },
    [evaluateLod, getViewport],
  );

  const onMoveEnd = useCallback(
    (_evt: unknown, viewport: Viewport) => {
      commit({ ...graphRef.current, viewport });
      lastLodVp.current = viewport;
      evaluateLod(viewport);
    },
    [commit, evaluateLod],
  );

  // Switching facets reframes the view around what the lens shows.
  const lastFacetId = useRef(activeFacetId);
  useEffect(() => {
    if (lastFacetId.current === activeFacetId) return;
    lastFacetId.current = activeFacetId;
    const timer = setTimeout(() => void fitView({ padding: 0.15, duration: 300 }), 60);
    return () => clearTimeout(timer);
  }, [activeFacetId, fitView]);

  const runAutoLayout = useCallback(
    (mode: "flow" | "layers" = "flow") => {
      // Nodes are laid out at their reserved LOD footprints (`slotSizes`) —
      // the same boxes they render collapsed at and fill when expanded, so
      // the layout holds unchanged at every level of detail.
      commit(autoLayout(graphRef.current, { mode, reserve: slotSizes }));
      // Let the new positions render, then bring everything into view.
      requestAnimationFrame(() => void fitView({ padding: 0.15, duration: 300 }));
    },
    [commit, fitView, slotSizes],
  );

  // A click pins the highlight into the deep link (`sel=`): it survives
  // reloads, travels in shared URLs, and every other surface rings it.
  const onNodeClick = useCallback(
    (_evt: unknown, node: RfNode) => {
      if (isCodeChildId(node.id)) {
        const ref = hlRefForChild(node.data as Partial<MapNodeData>);
        if (ref) pin(ref);
        return;
      }
      pin(hlRefFor(node.id));
    },
    [pin, hlRefFor, hlRefForChild],
  );
  const onPaneClick = useCallback(() => pin(null), [pin]);

  const onNodeDoubleClick = useCallback(
    (_evt: unknown, node: RfNode) => {
      if (isCodeChildId(node.id)) {
        const data = node.data as MapNodeData;
        if (data.nodeKind === "file" && !data.planned) toggleFile(data.path);
        else if (data.nodeKind === "symbol" && !data.planned) toggleCode(data.file, data.name);
        return;
      }
      const ref = codeRefForNode(node.id);
      if (ref?.file) {
        requestOpenFile(ref.file);
        return;
      }
      toggleNodeCode(node.id);
    },
    [codeRefForNode, toggleFile, toggleCode, toggleNodeCode],
  );

  const duplicateNode = useCallback(
    (id: string) => {
      const g = graphRef.current;
      const node = g.nodes.find((n) => n.id === id);
      if (!node) return;
      const copy = {
        ...structuredClone(node),
        id: uid("node"),
        label: `${node.label} copy`,
        position: { x: node.position.x + 32, y: node.position.y + 32 },
      };
      commit({ ...g, nodes: [...g.nodes, copy] });
      setSelectedNodes(new Set([copy.id]));
    },
    [commit],
  );

  const onNodeContextMenu = useCallback((evt: ReactMouseEvent, node: RfNode) => {
    evt.preventDefault();
    if (isCodeChildId(node.id)) {
      const data = node.data as MapNodeData;
      if (data.nodeKind === "file") {
        setMenu({ kind: "codefile", x: evt.clientX, y: evt.clientY, data: data as FileNodeData });
      } else if (data.nodeKind === "symbol") {
        setMenu({ kind: "codesymbol", x: evt.clientX, y: evt.clientY, data: data as SymbolNodeData });
      }
      return;
    }
    setMenu({ kind: "node", x: evt.clientX, y: evt.clientY, id: node.id });
  }, []);

  const onEdgeContextMenu = useCallback((evt: ReactMouseEvent, edge: ArchRfEdge) => {
    evt.preventDefault();
    setMenu({ kind: "edge", x: evt.clientX, y: evt.clientY, id: edge.id });
  }, []);

  const onPaneContextMenu = useCallback(
    (evt: MouseEvent | ReactMouseEvent) => {
      evt.preventDefault();
      setMenu({
        kind: "pane",
        x: evt.clientX,
        y: evt.clientY,
        flowPos: screenToFlowPosition({ x: evt.clientX, y: evt.clientY }),
      });
    },
    [screenToFlowPosition],
  );

  /** Modules with code that no diagram node links to yet. */
  const unmappedModules = useMemo(() => {
    if (!codeSummary) return [];
    const linked = new Set<string>();
    for (const n of graph.nodes) if (n.codeModule) linked.add(n.codeModule);
    for (const m of expanded.values()) linked.add(m);
    return codeSummary.modules.filter((m) => m.fileCount > 0 && !linked.has(m.path));
  }, [codeSummary, graph, expanded]);

  /** "Move to module ▸" entries shared by file/symbol menus. */
  const moveTargetEntries = useCallback(
    (ownModule: string, onPick: (modulePath: string) => void): MenuEntry[] => {
      const modules = (codeSummary?.modules ?? []).filter(
        (m) => m.fileCount > 0 && m.path !== ownModule,
      );
      if (modules.length === 0) return [{ type: "heading", label: "No other modules" }];
      return modules.map<MenuEntry>((m) => ({
        type: "item",
        label: m.name,
        hint: m.path === "." ? "(root)" : m.path,
        onSelect: () => onPick(m.path),
      }));
    },
    [codeSummary],
  );

  const menuEntries = useMemo<MenuEntry[]>(() => {
    if (!menu) return [];
    const g = graphRef.current;

    if (menu.kind === "pane") {
      return [
        {
          type: "submenu",
          label: "Add node",
          icon: Plus,
          entries: PALETTE_KINDS.map<MenuEntry>((kind) => ({
            type: "item",
            label: KIND_META[kind].label,
            icon: KIND_META[kind].icon,
            onSelect: () => addNodeAt(kind, menu.flowPos),
          })),
        },
        {
          type: "submenu",
          label: "Add code module",
          icon: Package,
          disabled: unmappedModules.length === 0,
          hint: unmappedModules.length ? String(unmappedModules.length) : "none left",
          entries: unmappedModules.map<MenuEntry>((m) => ({
            type: "item",
            label: m.name,
            hint: `${m.fileCount}f`,
            onSelect: () => addModuleNodeAt(m.path, m.name, menu.flowPos),
          })),
        },
        { type: "separator" },
        {
          type: "submenu",
          label: "Auto-layout",
          icon: LayoutGrid,
          entries: [
            { type: "item", label: "Flow — top to bottom", icon: LayoutGrid, onSelect: () => runAutoLayout("flow") },
            { type: "item", label: "Layers — by role (fullstack aware)", icon: Rows3, onSelect: () => runAutoLayout("layers") },
          ],
        },
        {
          type: "item",
          label: "Fit view",
          icon: Maximize2,
          onSelect: () => void fitView({ padding: 0.15, duration: 300 }),
        },
        { type: "separator" },
        {
          type: "item",
          label: "Workspaces map",
          icon: FolderGit2,
          disabled: !onOpenWorkspacesMap,
          onSelect: () => onOpenWorkspacesMap?.(),
        },
      ];
    }

    if (menu.kind === "node") {
      const node = g.nodes.find((n) => n.id === menu.id);
      if (!node) return [];
      const ref = codeRefForNode(node.id);
      const editorFile = editorFileForNode(node.id);
      const module = moduleForNode(node.id);
      const hint = ref ? (ref.file ? ref.file.split("/").pop() : ref.module) : undefined;
      const isLiveExpanded = expanded.has(node.id);
      const canExpandLive = isLiveExpanded || (!!module && !isContainerKind(node.kind) && !node.codeFile);
      const effectiveAccent = node.accent ?? KIND_META[node.kind].defaultAccent;

      // Facet membership: with a lens active, nodes move in and out of it;
      // otherwise the selection can become a new lens.
      const targets =
        selectedNodes.has(node.id) && selectedNodes.size > 1 ? [...selectedNodes] : [node.id];
      const facetEntries: MenuEntry[] = [];
      if (activeFacet) {
        const memberSet = new Set(activeFacet.nodeIds);
        const relatedIds = new Set([node.id, ...descendantsOf(g, node.id).map((d) => d.id)]);
        if ([...relatedIds].some((id) => memberSet.has(id))) {
          facetEntries.push({
            type: "item",
            label: `Remove from “${activeFacet.name}”`,
            icon: Layers,
            onSelect: () =>
              updateFacetMembers(activeFacet.id, (ids) => ids.filter((x) => !relatedIds.has(x))),
          });
        } else {
          facetEntries.push({
            type: "item",
            label: `Add to “${activeFacet.name}”`,
            icon: Layers,
            onSelect: () =>
              updateFacetMembers(activeFacet.id, (ids) => [...new Set([...ids, ...targets])]),
          });
        }
      } else {
        facetEntries.push({
          type: "item",
          label: targets.length > 1 ? "New facet from selection" : "New facet from this node",
          icon: Layers,
          hint: targets.length > 1 ? `${targets.length} nodes` : undefined,
          onSelect: () => {
            const cur = graphRef.current;
            const facet = createArchFacet(`Facet ${cur.facets.length + 1}`, targets);
            commit({ ...cur, facets: [...cur.facets, facet] });
            nav({ architect: { facet: facet.id } });
          },
        });
      }

      // Pin + hierarchy: the cross-view traversal entries. The chain walks
      // the containment annotations every rendered element carries.
      const nodeRef = hlRefFor(node.id);
      const pinnedHere =
        pinned != null && formatHighlightSel(pinned) === formatHighlightSel(nodeRef);
      const chain = ancestorsOf(g, node.id);
      const traversalEntries: MenuEntry[] = [
        pinnedHere
          ? { type: "item", label: "Unpin highlight", icon: PinOff, onSelect: () => pin(null) }
          : {
              type: "item",
              label: "Pin highlight",
              icon: Pin,
              hint: "sel in URL",
              onSelect: () => pin(nodeRef),
            },
        ...(chain.length
          ? [
              {
                type: "submenu",
                label: "Hierarchy",
                icon: GitFork,
                hint: `${chain.length + 1} levels`,
                entries: [
                  ...chain.map<MenuEntry>((a) => ({
                    type: "item",
                    label: a.label,
                    hint: KIND_META[a.kind].label,
                    onSelect: () => focusNode(a.id),
                  })),
                  {
                    type: "item",
                    label: node.label,
                    hint: KIND_META[node.kind].label,
                    checked: true,
                    onSelect: () => focusNode(node.id),
                  },
                ],
              } satisfies MenuEntry,
            ]
          : []),
      ];

      return [
        { type: "heading", label: node.label },
        {
          type: "item",
          label: "Rename",
          icon: Pencil,
          onSelect: () => setRenaming({ x: menu.x, y: menu.y, id: node.id }),
        },
        { type: "item", label: "Duplicate", icon: Copy, onSelect: () => duplicateNode(node.id) },
        ...facetEntries,
        { type: "separator" },
        ...traversalEntries,
        { type: "separator" },
        {
          type: "item",
          label: isLiveExpanded ? "Collapse code" : "Expand code",
          icon: isLiveExpanded ? Shrink : Expand,
          disabled: !canExpandLive,
          hint: !isLiveExpanded ? (module ?? undefined) : undefined,
          onSelect: () => toggleNodeCode(node.id),
        },
        {
          type: "item",
          label: "Peek code",
          icon: Code2,
          disabled: !ref,
          hint,
          onSelect: () => ref && setPeek({ module: ref.module, label: node.label, file: ref.file }),
        },
        {
          type: "item",
          label: "Open in editor",
          icon: ExternalLink,
          disabled: !editorFile,
          hint: editorFile ? editorFile.split("/").pop() : undefined,
          onSelect: () => editorFile && requestOpenFile(editorFile),
        },
        {
          type: "item",
          label: "Open terminal",
          icon: TerminalSquare,
          onSelect: () =>
            window.dispatchEvent(new CustomEvent("crystal:open-terminal", { detail: {} })),
        },
        ...(hasGeneratedChildren(g, node.id)
          ? [
              {
                type: "item",
                label: "Collapse generated code",
                icon: Shrink,
                onSelect: () => commit(collapseNode(graphRef.current, node.id)),
              } satisfies MenuEntry,
            ]
          : []),
        {
          type: "submenu",
          label: "Appearance",
          icon: Paintbrush,
          entries: [
            { type: "heading", label: "Accent" },
            ...(Object.keys(ACCENT_CSS) as AccentName[]).map<MenuEntry>((name) => ({
              type: "item",
              label: name,
              checked: effectiveAccent === name,
              onSelect: () =>
                commit(updateNode(graphRef.current, node.id, { accent: name })),
            })),
            { type: "separator" },
            { type: "heading", label: "Layer" },
            {
              type: "item",
              label: "Auto (from kind)",
              checked: node.layer == null,
              onSelect: () => commit(updateNode(graphRef.current, node.id, { layer: null })),
            },
            ...(["entry", "service", "data"] as const).map<MenuEntry>((layer) => ({
              type: "item",
              label: layer,
              checked: node.layer === layer,
              onSelect: () => commit(updateNode(graphRef.current, node.id, { layer })),
            })),
          ],
        },
        { type: "separator" },
        {
          type: "item",
          label: isContainerKind(node.kind) ? "Delete container + contents" : "Delete",
          icon: Trash2,
          danger: true,
          onSelect: () => {
            commit(deleteNodes(graphRef.current, [node.id]));
            setSelectedNodes(new Set());
          },
        },
      ];
    }

    if (menu.kind === "codefile") {
      const d = menu.data;
      return [
        { type: "heading", label: d.name },
        {
          type: "item",
          label: d.expanded ? "Collapse file" : "Expand file",
          icon: d.expanded ? Shrink : Expand,
          disabled: !!d.planned,
          onSelect: () => toggleFile(d.path),
        },
        {
          type: "item",
          label: "Pin highlight",
          icon: Pin,
          disabled: !!d.planned,
          onSelect: () => pin({ file: d.path, module: d.module, label: d.name }),
        },
        {
          type: "item",
          label: "Open in editor",
          icon: ExternalLink,
          onSelect: () => requestOpenFile(d.path),
        },
        {
          type: "item",
          label: "Copy path",
          icon: Copy,
          hint: d.path.split("/").pop(),
          onSelect: () => void navigator.clipboard?.writeText(d.path),
        },
        { type: "separator" },
        {
          type: "submenu",
          label: "Move file to module",
          icon: MoveUpRight,
          disabled: !onRecordFileMove || !!d.planned,
          entries: moveTargetEntries(d.module, (m) => void onRecordFileMove?.(d.path, m)),
        },
      ];
    }

    if (menu.kind === "codesymbol") {
      const d = menu.data;
      const journeyable = d.kind !== "reexport" && d.kind !== "default";
      return [
        { type: "heading", label: d.name },
        {
          type: "item",
          label: d.codeOpen ? "Hide source" : "Show source",
          icon: Code2,
          disabled: !!d.planned,
          onSelect: () => toggleCode(d.file, d.name),
        },
        {
          type: "item",
          label: "Start journey here",
          icon: Route,
          disabled: !onStartJourney || !journeyable || !!d.planned,
          onSelect: () => onStartJourney?.({ file: d.file, symbol: d.name }),
        },
        {
          type: "item",
          label: "Pin highlight",
          icon: Pin,
          disabled: !!d.planned,
          onSelect: () => pin({ file: d.file, symbol: d.name, module: d.module, label: d.name }),
        },
        {
          type: "item",
          label: "Open file in editor",
          icon: ExternalLink,
          onSelect: () => requestOpenFile(d.file),
        },
        {
          type: "item",
          label: "Copy reference",
          icon: Copy,
          hint: `${d.file.split("/").pop()}#${d.name}`,
          onSelect: () => void navigator.clipboard?.writeText(`${d.file}#${d.name}`),
        },
        { type: "separator" },
        {
          type: "submenu",
          label: "Move to module",
          icon: MoveUpRight,
          disabled: !onRecordMove || !!d.planned || d.kind === "reexport",
          entries: moveTargetEntries(d.module, (m) =>
            void onRecordMove?.({ file: d.file, symbol: d.name }, { module: m }),
          ),
        },
      ];
    }

    // Edge menu. Ghost edges (code-only) get a single "draw it" action.
    if (menu.id.startsWith("ghost:")) {
      const ghost = overlay?.ghostEdges.find(
        (e) => `ghost:${e.sourceModule}->${e.targetModule}` === menu.id,
      );
      if (!ghost) return [];
      return [
        { type: "heading", label: "Code-only dependency" },
        {
          type: "item",
          label: "Add to diagram",
          icon: Plus,
          onSelect: () =>
            commit(opAddEdge(graphRef.current, ghost.source, ghost.target, "dependency")),
        },
      ];
    }
    const edge = g.edges.find((e) => e.id === menu.id);
    if (!edge) return [];
    const endpointName = (id: string) => g.nodes.find((n) => n.id === id)?.label ?? "?";
    return [
      { type: "heading", label: edge.label || "Connection" },
      {
        type: "item",
        label: `Go to “${endpointName(edge.source)}”`,
        icon: MoveUpRight,
        hint: "source",
        onSelect: () => focusNode(edge.source),
      },
      {
        type: "item",
        label: `Go to “${endpointName(edge.target)}”`,
        icon: MoveUpRight,
        hint: "target",
        onSelect: () => focusNode(edge.target),
      },
      { type: "separator" },
      {
        type: "submenu",
        label: "Connection kind",
        icon: Pencil,
        entries: ARCH_EDGE_KINDS.map<MenuEntry>((kind) => ({
          type: "item",
          label: EDGE_KIND_STYLE[kind].label,
          checked: edge.kind === kind,
          onSelect: () => commit(updateEdge(graphRef.current, edge.id, { kind })),
        })),
      },
      { type: "separator" },
      {
        type: "item",
        label: "Delete connection",
        icon: Trash2,
        danger: true,
        onSelect: () => {
          commit(deleteEdges(graphRef.current, [edge.id]));
          setSelectedEdges(new Set());
        },
      },
    ];
  }, [
    menu,
    codeRefForNode,
    editorFileForNode,
    focusNode,
    moduleForNode,
    expanded,
    toggleNodeCode,
    toggleFile,
    toggleCode,
    onOpenWorkspacesMap,
    onStartJourney,
    onRecordMove,
    onRecordFileMove,
    moveTargetEntries,
    unmappedModules,
    addNodeAt,
    addModuleNodeAt,
    runAutoLayout,
    fitView,
    duplicateNode,
    commit,
    overlay,
    activeFacet,
    updateFacetMembers,
    selectedNodes,
    nav,
    hlRefFor,
    pin,
    pinned,
  ]);

  const mapActions = useMemo<MapActions>(
    () => ({
      toggleModule: () => {},
      toggleFile,
      toggleCode,
      toggleAllFiles,
      startJourney: onStartJourney,
      dropSymbol: (payload, target) => void onRecordMove?.(payload, target),
    }),
    [toggleFile, toggleCode, toggleAllFiles, onStartJourney, onRecordMove],
  );

  const selectedNode =
    selectedNodes.size === 1 ? graph.nodes.find((n) => selectedNodes.has(n.id)) : undefined;
  const selectedEdge =
    selectedNodes.size === 0 && selectedEdges.size === 1
      ? graph.edges.find((e) => selectedEdges.has(e.id))
      : undefined;

  /** First diagram node linked to each module — targets for insight-row jumps. */
  const moduleNodeIds = useMemo(() => {
    const m = new Map<string, string>();
    if (!codeSummary) return m;
    for (const [nodeId, badge] of linkNodesToModules(graph, codeSummary)) {
      if (!m.has(badge.module)) m.set(badge.module, nodeId);
    }
    return m;
  }, [graph, codeSummary]);

  // What the side pane explains about the selected node: its drawn
  // connections plus the linked module's real import/export relationships.
  const selectedInsight = useMemo<NodeInsight | null>(() => {
    if (!selectedNode || selectedNode.kind === "note") return null;
    const nameOf = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? "?";
    const uses: NodeInsight["uses"] = [];
    const usedBy: NodeInsight["usedBy"] = [];
    for (const e of graph.edges) {
      if (e.source === selectedNode.id) {
        uses.push({ nodeId: e.target, label: nameOf(e.target), kind: e.kind });
      } else if (e.target === selectedNode.id) {
        usedBy.push({ nodeId: e.source, label: nameOf(e.source), kind: e.kind });
      }
    }
    const module = moduleForNode(selectedNode.id);
    const imports: NodeInsight["imports"] = [];
    const importedBy: NodeInsight["importedBy"] = [];
    if (module && codeSummary) {
      for (const d of codeSummary.deps) {
        if (d.source === module) {
          imports.push({ module: d.target, weight: d.weight, nodeId: moduleNodeIds.get(d.target) ?? null });
        } else if (d.target === module) {
          importedBy.push({ module: d.source, weight: d.weight, nodeId: moduleNodeIds.get(d.source) ?? null });
        }
      }
      imports.sort((a, b) => b.weight - a.weight);
      importedBy.sort((a, b) => b.weight - a.weight);
    }
    return {
      module,
      detail: module ? (moduleDetailMap.get(module) ?? null) : null,
      uses,
      usedBy,
      imports,
      importedBy,
    };
  }, [selectedNode, graph, moduleForNode, moduleDetailMap, codeSummary, moduleNodeIds]);

  // External reveals (flamegraph frames, trace steps): select + pan + pulse.
  const highlightNonce = useRef(0);
  useEffect(() => {
    if (!highlightRequest || highlightRequest.nonce === highlightNonce.current) return;
    highlightNonce.current = highlightRequest.nonce;
    const { nodeId } = highlightRequest;
    // Hidden by the active facet (or deleted since the trace ran) — nothing to point at.
    if (!viewGraph.nodes.some((n) => n.id === nodeId)) return;
    focusNode(nodeId);
    setFlashId(nodeId);
    const timer = setTimeout(() => setFlashId(null), 1300);
    return () => clearTimeout(timer);
  }, [highlightRequest, viewGraph, focusNode]);

  // A pinned highlight arriving from another surface (or a shared URL)
  // reveals itself: resolve to a diagram node, select, pan, pulse. Pins made
  // by clicking on this canvas already have their node selected — skipped.
  const selectedNodesRef = useRef(selectedNodes);
  selectedNodesRef.current = selectedNodes;
  const lastPinKey = useRef<string | null>(null);
  useEffect(() => {
    const key = pinned ? formatHighlightSel(pinned) : null;
    if (key === lastPinKey.current) return;
    lastPinKey.current = key;
    if (!pinned) return;
    const nodeId =
      pinned.node && viewGraph.nodes.some((n) => n.id === pinned.node)
        ? pinned.node
        : (enrichHighlight(pinned, { graph: viewGraph, modules: codeSummary?.modules ?? null })
            .node ?? null);
    if (!nodeId || selectedNodesRef.current.has(nodeId)) return;
    focusNode(nodeId);
    setFlashId(nodeId);
    const timer = setTimeout(() => setFlashId(null), 1300);
    return () => clearTimeout(timer);
  }, [pinned, viewGraph, codeSummary, focusNode]);

  return (
    <MapActionsContext.Provider value={mapActions}>
    <div
      ref={wrapperRef}
      className={cn(
        "relative h-full w-full",
        draftMode && "ring-2 ring-inset ring-warn/50",
      )}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        snapToGrid
        snapGrid={[8, 8]}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        zoomOnDoubleClick={false}
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onMove={onMove}
        onMoveEnd={onMoveEnd}
        defaultViewport={graph.viewport ?? undefined}
        fitView={!graph.viewport}
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.05}
        maxZoom={2.5}
        deleteKeyCode={["Delete", "Backspace"]}
        selectionOnDrag={false}
        panOnScroll
        zoomOnPinch
        proOptions={{ hideAttribution: true }}
        className="bg-surface-0"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.25} color="var(--color-edge-strong)" />
        <MiniMap
          pannable
          zoomable
          className="!bottom-3 !right-3 !h-32 !w-44 rounded-lg border border-edge !bg-surface-1"
          maskColor="rgba(6, 8, 12, 0.72)"
          nodeColor={(n) => {
            const data = n.data as Partial<ArchRfNode["data"]>;
            return data.arch ? accentOf(data.arch) : "var(--color-crystal-500)";
          }}
          nodeStrokeWidth={0}
        />
        <Controls
          position="bottom-left"
          showInteractive={false}
          className="!rounded-lg !border !border-edge !bg-surface-2 !shadow-lg overflow-hidden"
        />
        <Panel position="top-left">
          <Toolbar
            graph={graph}
            facet={
              activeFacet
                ? {
                    name: activeFacet.name,
                    shown: viewGraph.nodes.length,
                    total: graph.nodes.length,
                    empty: activeFacet.nodeIds.length === 0,
                  }
                : null
            }
            onExitFacet={() => nav({ architect: { facet: null } })}
            defaultEdgeKind={defaultEdgeKind}
            onDefaultEdgeKindChange={setDefaultEdgeKind}
            onAutoLayout={runAutoLayout}
            onFitView={() => void fitView({ padding: 0.15, duration: 300 })}
            onRename={(name) => commit({ ...graphRef.current, name })}
            lodOn={lodOn}
            onToggleLod={toggleLod}
            lodLevel={lodLevel}
            onLodLevelChange={setLodLevel}
            lodCounts={lodCounts}
            overlayOn={overlayOn}
            onToggleOverlay={onToggleOverlay}
            showDuplicates={showDuplicates}
            onToggleDuplicates={onToggleDuplicates}
            showFindings={showFindings}
            onToggleFindings={onToggleFindings}
            onOpenWorkspacesMap={onOpenWorkspacesMap}
          />
        </Panel>
        <Panel position="center-left">
          <Palette onAdd={addAtViewportCenter} />
        </Panel>
        {overlay || hoverNeighborhood ? (
          <Panel position="bottom-center">
            <div className="flex flex-col items-center gap-1.5">
              {hoverNeighborhood ? <HoverLegend /> : null}
              {overlay ? (
                <OverlayLegend
                  overlay={overlay}
                  onAdoptAutoLinks={() => commit(adoptAutoLinks(graphRef.current, overlay))}
                />
              ) : null}
            </div>
          </Panel>
        ) : null}
      </ReactFlow>

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries} onClose={() => setMenu(null)} />
      ) : null}
      {peek ? (
        <PeekPanel
          module={peek.module}
          nodeLabel={peek.label}
          initialFile={peek.file}
          onClose={() => setPeek(null)}
          onOpenFile={requestOpenFile}
        />
      ) : null}
      {renaming ? (
        <InlineRename
          x={renaming.x}
          y={renaming.y}
          initial={graph.nodes.find((n) => n.id === renaming.id)?.label ?? ""}
          onCommit={(label) => {
            commit(updateNode(graphRef.current, renaming.id, { label }));
            setRenaming(null);
          }}
          onCancel={() => setRenaming(null)}
        />
      ) : null}

      {selectedNode || selectedEdge ? (
        <Inspector
          graph={graph}
          node={selectedNode}
          edge={selectedEdge}
          codeModules={codeSummary?.modules}
          insight={selectedInsight}
          onFocusNode={focusNode}
          onGraphChange={commit}
          onClearSelection={() => {
            setSelectedNodes(new Set());
            setSelectedEdges(new Set());
          }}
        />
      ) : null}
    </div>
    </MapActionsContext.Provider>
  );
}

/** What the hover colors mean while a node's neighborhood is spotlit. */
function HoverLegend() {
  const swatch = (color: string) => (
    <span className="inline-block w-4 shrink-0" style={{ borderTop: `2px solid ${color}` }} />
  );
  return (
    <div className="flex items-center gap-3 rounded-xl border border-edge bg-surface-2/95 px-3 py-1.5 text-[10px] text-ink-muted shadow-xl shadow-black/30 backdrop-blur">
      <span className="flex items-center gap-1.5">{swatch(HOVER_OUT_STROKE)} uses / imports</span>
      <span className="flex items-center gap-1.5">{swatch(HOVER_IN_STROKE)} used by / exports to</span>
    </div>
  );
}

function OverlayLegend({
  overlay,
  onAdoptAutoLinks,
}: {
  overlay: OverlayResult;
  onAdoptAutoLinks: () => void;
}) {
  const autoCount = [...overlay.nodeBadges.values()].filter((b) => b.auto).length;
  const swatch = (border: string) => (
    <span className="inline-block w-4 shrink-0" style={{ borderTop: border }} />
  );
  return (
    <div className="flex items-center gap-3 rounded-xl border border-edge bg-surface-2/95 px-3 py-1.5 text-[10px] text-ink-muted shadow-xl shadow-black/30 backdrop-blur">
      <span className="flex items-center gap-1.5">
        {swatch("2px solid var(--color-ok)")} in code ({overlay.confirmedEdgeIds.size})
      </span>
      <span className="flex items-center gap-1.5">
        {swatch("2px dashed var(--color-crystal-400)")} code only ({overlay.ghostEdges.length})
      </span>
      <span className="flex items-center gap-1.5">
        {swatch("2px dashed var(--color-warn)")} diagram only ({overlay.staleEdgeIds.size})
      </span>
      {overlay.unmappedModules.length > 0 ? (
        <span className="text-ink-faint">{overlay.unmappedModules.length} unlinked modules</span>
      ) : null}
      {autoCount > 0 ? (
        <button
          type="button"
          onClick={onAdoptAutoLinks}
          className="rounded-md bg-crystal-500/15 px-1.5 py-0.5 font-medium text-crystal-300 hover:bg-crystal-500/25"
        >
          Keep {autoCount} suggested link{autoCount > 1 ? "s" : ""}
        </button>
      ) : null}
    </div>
  );
}

export function ArchitectCanvas(props: ArchitectCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner key={props.graph.id} {...props} />
    </ReactFlowProvider>
  );
}
