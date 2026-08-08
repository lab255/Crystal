import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type Node as RfNode,
  type Viewport,
} from "@xyflow/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  Code2,
  Copy,
  Expand,
  ExternalLink,
  FileText,
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
  canonicalSystemIds,
  createArchFacet,
  descendantsOf,
  enrichHighlight,
  filterGraphToFacet,
  formatHighlightSel,
  isContainerKind,
  linkByEdgeId,
  linkEdgeId,
  uid,
  type ArchNode,
  type ArchEdgeKind,
  type ArchNodeKind,
  type ArchitectureGraph,
  type C4View,
  type CodeFileDetail,
  type CodeLodLevel,
  type CodeMapSummary,
  type DiffMarks,
  type CodeModuleDetail,
  type HighlightRef,
  type SystemOverview,
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
import { useCrystal, useNav, useNavUpdate, useSymbolMenu, useWorkspaces } from "@crystal/client";
import { cn } from "@crystal/ui";
import { ContextMenu, InlineRename, type MenuEntry } from "./ContextMenu.js";
import { collapseNode, hasGeneratedChildren } from "./expand.js";
import { autoLayoutFitted } from "./layout.js";
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
  buildCodeContent,
  cappedExpansionFiles,
  unifiedDropTargetAt,
  type HitTestNode,
} from "./live-code.js";
import { resolveCollisions, type DisplaceRect } from "./displace.js";
import { BusbarEdge } from "./BusbarEdge.js";
import { estimateGraphDims } from "./card-metrics.js";
import { PeekPanel } from "./snippets.js";
import { Palette, DRAG_MIME, PALETTE_KINDS } from "./Palette.js";
import { Toolbar } from "./Toolbar.js";
import { CANVAS_LOD_LEVELS, HUGE_TREE_FILE_LIMIT } from "./lod-config.js";
import { useViewHighlight } from "./use-highlight.js";
import {
  HOVER_IN_STROKE,
  HOVER_OUT_STROKE,
  decorateEdges,
  decorateNodes,
} from "./decorate.js";
import {
  buildPartsContent,
  multiPartSystems,
  splitEdgesByParts,
  type PartRfNode,
} from "./part-split.js";
import { PartNode } from "./nodes/PartNode.js";
import { ElkEdge } from "./nodes/ElkEdge.js";
import { buildSystemCardFacts, systemCardSlot } from "./system-card.js";

const nodeTypes = {
  container: ContainerNode,
  leaf: LeafNode,
  note: NoteNode,
  part: PartNode,
  codeFile: mapNodeTypes.codeFile,
  codeSymbol: mapNodeTypes.codeSymbol,
  codeOverflow: mapNodeTypes.codeOverflow,
};

const edgeTypes = {
  busbar: BusbarEdge,
  elk: ElkEdge,
};

type CanvasNode = ArchRfNode | MapRfNode | PartRfNode;

/** Ephemeral children (live code, part tier) carry generated ids, never graph node ids. */
function isCodeChildId(id: string): boolean {
  return (
    id.startsWith("f:") ||
    id.startsWith("s:") ||
    id.startsWith("part:") ||
    id.startsWith("plan:") ||
    id.startsWith("planfile:") ||
    id.startsWith("morefiles:")
  );
}

export interface ArchitectCanvasProps {
  graph: ArchitectureGraph;
  onChange: (graph: ArchitectureGraph) => void;
  /** Absolute ELK polylines for edges whose endpoints still match the solve. */
  edgeRoutes?: ReadonlyMap<string, { x: number; y: number }[]> | null;
  /** Browser-measured card footprints fed back into the asynchronous layout. */
  onMeasured?: (sizes: ReadonlyMap<string, { width: number; height: number }>) => void;
  /** C4 resets its per-view pins; other canvases commit a dagre layout. */
  onAutoLayout?: () => void;
  /** Compact view controls that share a header lane above the canvas toolbar. */
  headerExtra?: ReactNode;
  /** Live code map for the overlay + code expansion; null while unavailable. */
  codeSummary?: CodeMapSummary | null;
  /**
   * Systems overview — powers the part tier: multi-part systems can expand
   * into their parts, boundary edges split along `SystemLink.parts`, and the
   * intra-system `partLinks` wire the inside. Null = the feature is off.
   */
  overview?: SystemOverview | null;
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
  showChanges?: boolean;
  onToggleChanges?: (on: boolean) => void;
  showInsights?: boolean;
  onToggleInsights?: (on: boolean) => void;
  showContracts?: boolean;
  onToggleContracts?: (on: boolean) => void;
  /** Screens layer toggle (the folded-in surfaces map). */
  showScreens?: boolean;
  onToggleScreens?: (on: boolean) => void;
  /** Data-schema entities in C4 component projections. */
  showData?: boolean;
  onToggleData?: (on: boolean) => void;
  /** Routes tier of the screens layer — called endpoints as their own nodes. */
  showEndpoints?: boolean;
  onToggleEndpoints?: (on: boolean) => void;
  /** View-supplied entries prepended to a node's context menu (focus filter…). */
  extraNodeEntries?: (node: ArchNode) => MenuEntry[];
  /**
   * Open the boundary contract for a derived `link:` edge (the contracts
   * panel keyed on the raw overview pair). Returns false when the edge has
   * no contract (manual edges) so the caller can fall back silently.
   */
  onOpenContract?: (edgeId: string) => boolean;
  /**
   * Ref-review marks keyed by node/edge id (vs <ref>) — added/removed/changed
   * tints; ghost-marked nodes render dashed and inert. The caller merges
   * ghost nodes into `graph` itself (they need layout like everything else).
   */
  diffMarks?: DiffMarks | null;
  /**
   * C4 mode (the architecture view's projection): element type lines per
   * node, and drill-down targets — double-clicking a node with a drill entry
   * descends a C4 level instead of toggling live code. Absent everywhere
   * else (drafts, the surfaces embed, infra), where the canvas behaves as
   * before.
   */
  c4?: {
    typeLines: Record<string, string>;
    drill: Record<string, C4View>;
    onDrill: (view: C4View) => void;
  } | null;
}

const GHOST_STROKE = "var(--color-crystal-400)";
const FLOW_STROKE = "var(--color-crystal-400)";
/** Hover lens: what the hovered node uses (imports) vs what uses it (exports). */

/*
 * Level of detail is explicit here: the C4 altitude and the discrete detail
 * ladder decide what renders, and per-node expand/collapse (double-click,
 * context menu, the ladder's stops) opens live code on demand. Zoom never
 * changes what a card shows — detail that appears and disappears under the
 * cursor reads as noise, so the old zoom-driven engine is gone.
 */

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
  edgeRoutes,
  onMeasured,
  onAutoLayout,
  headerExtra,
  codeSummary,
  overview,
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
  showChanges,
  onToggleChanges,
  showInsights,
  onToggleInsights,
  showContracts,
  onToggleContracts,
  showScreens,
  onToggleScreens,
  showData,
  onToggleData,
  showEndpoints,
  onToggleEndpoints,
  extraNodeEntries,
  onOpenContract,
  diffMarks,
  c4,
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
  const { screenToFlowPosition, fitView, getNodes } = useReactFlow();
  const nodesInitialized = useNodesInitialized();

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
  /** Systems opened into their part tier ("Expand components"). */
  const [partsOpen, setPartsOpen] = useState<ReadonlySet<string>>(() => new Set());
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

  // The server re-analyzes when code changes on disk — refresh expanded content.
  useEffect(
    () =>
      client.events.on("codemap.changed", ({ ws }) => {
        if (!activeWs || ws === activeWs) setGeneration((g) => g + 1);
      }),
    [client, activeWs],
  );

  /* ---------------- part tier (multi-part systems open into parts) ---------------- */

  /** Canonical node id → system, for systems that can open into parts. */
  const partSystems = useMemo(
    () => (overview ? multiPartSystems(overview) : null),
    [overview],
  );
  /** Canonical `link:` edge id → overview link, for boundary-edge splitting. */
  const partLinkOf = useMemo(() => {
    if (!overview) return null;
    const idOfRaw = canonicalSystemIds(overview.systems);
    return linkByEdgeId(overview, (raw) => idOfRaw.get(raw) ?? raw);
  }, [overview]);
  /**
   * Canonical node id → semantic card facts (exports × consumers, consumes
   * footer, role) — the retired systems view's card body, joined onto canvas
   * nodes. Plain records only: node data must stay structured-clonable.
   */
  const systemCards = useMemo(
    () => (overview ? buildSystemCardFacts(overview) : null),
    [overview],
  );
  /** Only systems that still exist (and the facet shows) stay open. */
  const partsExpanded = useMemo(() => {
    if (!partSystems || partsOpen.size === 0) return null;
    const present = new Set(viewGraph.nodes.map((n) => n.id));
    const ids = new Set<string>();
    for (const id of partsOpen) if (partSystems.has(id) && present.has(id)) ids.add(id);
    return ids.size > 0 ? (ids as ReadonlySet<string>) : null;
  }, [partsOpen, partSystems, viewGraph]);
  const partsContent = useMemo(
    () => buildPartsContent(partsExpanded ?? new Set(), partSystems),
    [partsExpanded, partSystems],
  );

  // Only nodes that still exist (and the facet shows) expand; a deleted or
  // hidden node drops its code children. The part tier wins over live code —
  // they are alternate interiors of the same container.
  const expanded = useMemo(() => {
    const ids = new Set(viewGraph.nodes.map((n) => n.id));
    const m = new Map<string, string>();
    for (const [id, module] of codeExpanded)
      if (ids.has(id) && !partsExpanded?.has(id)) m.set(id, module);
    return m as ReadonlyMap<string, string>;
  }, [codeExpanded, viewGraph, partsExpanded]);

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
      if (next.has(path)) next.delete(path);
      else next.add(path);
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
  const symbolMenu = useSymbolMenu();

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

  /** Identity of an ephemeral child (file card / symbol chip / part card). */
  const hlRefForChild = useCallback((data: Partial<MapNodeData>): HighlightRef | null => {
    if (data.nodeKind === "file" && data.path)
      return { file: data.path, module: data.module, label: data.name };
    if (data.nodeKind === "symbol" && data.file && data.name)
      return { file: data.file, symbol: data.name, module: data.module, label: data.name };
    const part = (data as { part?: { path: string; pkg: string } }).part;
    if (part) return { module: part.pkg, label: part.path.split("/").pop() || part.path };
    return null;
  }, []);

  /**
   * Card slots: system cards render at the size their semantic body needs
   * (exports rows + consumes footer) so the body always fits its box. That is
   * the only reservation — collapsed cards no longer hold their module
   * expansion's worst-case footprint, so the layout is as compact as the
   * cards themselves; an expansion that outgrows its card pushes neighbors
   * aside via the displacement pass instead.
   */
  const slotSizes = useMemo(() => {
    const sizes = new Map<string, { width: number; height: number }>();
    if (!systemCards) return sizes;
    for (const [id, facts] of systemCards) sizes.set(id, systemCardSlot(facts));
    return sizes;
  }, [systemCards]);

  // Module details are fetched for expanded nodes only — collapsed cards
  // summarize from the overview, so nothing bulk-loads at rest.
  useEffect(() => {
    for (const module of new Set(expanded.values())) {
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
  }, [client, expanded, generation, moduleDetails]);

  /* ---------------- hover lens: imports and exports of one node ---------------- */

  const [dragActive, setDragActive] = useState(false);

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
    if (expanded.size === 0 && !partsExpanded) {
      displaceRef.current = new Map();
      return displaceRef.current;
    }
    const opened = new Set<string>([...expanded.keys(), ...(partsExpanded ?? [])]);
    const scopes = new Set<string | null>();
    for (const id of opened) {
      const n = viewGraph.nodes.find((x) => x.id === id);
      if (n) scopes.add(n.parentId ?? null);
    }
    const out = new Map<string, { dx: number; dy: number }>();
    for (const scope of scopes) {
      const members = viewGraph.nodes.filter((n) => (n.parentId ?? null) === scope);
      const rects: DisplaceRect[] = members.map((n) => {
        // Rendered footprint: expanded content and the reserved slot cover the
        // same box by construction, so expansion usually displaces nothing.
        const content = expanded.has(n.id)
          ? codeContent.sizes.get(n.id)
          : partsExpanded?.has(n.id)
            ? partsContent.sizes.get(n.id)
            : undefined;
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
          fixed: opened.has(n.id),
        };
      });
      for (const [id, off] of resolveCollisions(rects)) out.set(id, off);
    }
    displaceRef.current = out;
    return out;
  }, [expanded, codeContent, partsExpanded, partsContent, viewGraph, slotSizes, dragActive]);

  /** Cross-view identity per diagram node, stamped into node data (DOM attrs). */
  const nodeHlRefs = useMemo(() => {
    const m = new Map<string, HighlightRef>();
    for (const n of viewGraph.nodes) m.set(n.id, hlRefFor(n.id));
    return m;
  }, [viewGraph, hlRefFor]);

  // Global find (the Architecture header's box): nodes that miss the query
  // dim. Matches name, description, tech and code links; ancestors of a match
  // stay visible so a hit inside a container keeps its context readable.
  const findQuery = (useNav((l) => l.architect?.find) ?? "").trim().toLowerCase();
  const findMisses = useMemo(() => {
    if (!findQuery) return null;
    const byId = new Map(viewGraph.nodes.map((n) => [n.id, n]));
    const matches = new Set<string>();
    for (const n of viewGraph.nodes) {
      const text = [n.label, n.description ?? "", ...n.tech, n.codeModule ?? "", n.codeFile ?? ""]
        .join("\n")
        .toLowerCase();
      if (text.includes(findQuery)) matches.add(n.id);
    }
    for (const id of [...matches]) {
      let parent = byId.get(id)?.parentId;
      while (parent) {
        matches.add(parent);
        parent = byId.get(parent)?.parentId;
      }
    }
    const misses = new Set<string>();
    for (const n of viewGraph.nodes) if (!matches.has(n.id)) misses.add(n.id);
    return misses;
  }, [findQuery, viewGraph]);

  /** Hover published by another surface — this canvas echoes its own via the lens. */
  const externalHover = hoverSource !== "canvas" ? extHover : null;

  const rfNodes = useMemo<CanvasNode[]>(() => {
    let nodes: CanvasNode[] = toRfNodes(viewGraph, selectedNodes, slotSizes, diffMarks).map((n) => {
      const hlRef = nodeHlRefs.get(n.id);
      return hlRef ? ({ ...n, data: { ...n.data, hlRef } } as ArchRfNode) : n;
    });
    if (c4) {
      nodes = nodes.map((n) => {
        const c4Type = c4.typeLines[n.id];
        return c4Type ? ({ ...n, data: { ...n.data, c4Type } } as ArchRfNode) : n;
      });
    }
    if (overlay) {
      nodes = nodes.map((n) => {
        const code = overlay.nodeBadges.get(n.id);
        return code ? ({ ...n, data: { ...n.data, code } } as ArchRfNode) : n;
      });
    }
    if (systemCards && systemCards.size > 0) {
      // System cards carry their semantic body (exports, consumes, role).
      nodes = nodes.map((n) => {
        const system = systemCards.get(n.id);
        return system ? ({ ...n, data: { ...n.data, system } } as ArchRfNode) : n;
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
    if (partsExpanded) {
      // Same convention as live code: the opened system renders as a
      // container that never shrinks below its reserved slot, part cards
      // appended as children (parents already precede them in the array).
      nodes = nodes.map((n) => {
        if (!partsExpanded.has(n.id)) return n;
        const content = partsContent.sizes.get(n.id);
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
          data: { ...n.data, partsExpanded: true },
        } as ArchRfNode;
      });
      nodes = [...nodes, ...partsContent.nodes];
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
    return nodes;
  }, [viewGraph, selectedNodes, slotSizes, diffMarks, c4, overlay, systemCards, flow, expanded, codeContent, partsExpanded, partsContent, dragOverrides, displacements, dragActive, nodeHlRefs]);

  const rfEdges = useMemo(() => {
    // ELK routes describe base node coordinates. Expanded-code displacement
    // and in-flight drags are view-only, so suppress affected routes until
    // those endpoints return to the solved geometry.
    const byId = new Map(viewGraph.nodes.map((node) => [node.id, node]));
    const transientlyMoved = (id: string): boolean => {
      let node = byId.get(id);
      const seen = new Set<string>();
      while (node && !seen.has(node.id)) {
        if (dragOverrides.has(node.id) || displacements.has(node.id)) return true;
        seen.add(node.id);
        node = node.parentId ? byId.get(node.parentId) : undefined;
      }
      return false;
    };
    let renderRoutes = edgeRoutes;
    if (edgeRoutes && (dragOverrides.size > 0 || displacements.size > 0)) {
      let filteredRoutes: Map<string, { x: number; y: number }[]> | null = null;
      for (const edge of viewGraph.edges) {
        if (
          !edgeRoutes.has(edge.id) ||
          (!transientlyMoved(edge.source) && !transientlyMoved(edge.target))
        ) continue;
        filteredRoutes ??= new Map(edgeRoutes);
        filteredRoutes.delete(edge.id);
      }
      renderRoutes = filteredRoutes ?? edgeRoutes;
    }
    let edges = [
      ...toRfEdges(viewGraph, selectedEdges, diffMarks, renderRoutes),
      ...(codeContent.edges as ArchRfEdge[]),
    ];
    if (overlay) edges = applyOverlayToEdges(edges, overlay);
    if (flow) edges = applyFlowToEdges(edges, flow);
    if (partsExpanded && partLinkOf) {
      // Boundary edges of an opened system split along their part
      // attribution (the aggregate is suppressed); the system's internal
      // part wiring rides along.
      edges = splitEdgesByParts(edges, {
        expanded: partsExpanded,
        linkOf: partLinkOf,
        maxWeight: Math.max(1, ...viewGraph.edges.map((e) => e.weight ?? 0)),
      });
      edges = [...edges, ...(partsContent.edges as ArchRfEdge[])];
    }
    return edges;
  }, [viewGraph, selectedEdges, diffMarks, edgeRoutes, dragOverrides, displacements, overlay, flow, codeContent, partsExpanded, partLinkOf, partsContent]);

  /**
   * Ids to keep lit while `hovered` is set: the node itself plus everything
   * it connects to. Derived from the rendered edges, so ghost edges,
   * live-code imports, part wiring and split boundaries all count. Edge
   * direction is reported separately by the edge decoration.
   */
  const hoverNeighborhood = useMemo(() => {
    if (!hovered) return null;
    const nodes = new Set<string>([hovered]);
    for (const e of rfEdges) {
      if (e.source === hovered) nodes.add(e.target);
      else if (e.target === hovered) nodes.add(e.source);
    }
    return nodes;
  }, [hovered, rfEdges]);

  // Decorations (hover spotlight, find dimming, flash, cross-view rings) ride
  // a separate identity-preserving pass: a hover change must never invalidate
  // the structural memos above — that rebuilt every node's `data`, defeated
  // React.memo on all card components, and cost ~9 full array passes per
  // mouse-enter.
  const displayNodes = useMemo(
    () =>
      decorateNodes(
        rfNodes,
        { findMisses, flashId, hovered, hoverNeighborhood, externalHover, pinned },
        hlRefForChild,
      ),
    [rfNodes, findMisses, flashId, hovered, hoverNeighborhood, externalHover, pinned, hlRefForChild],
  );

  const displayEdges = useMemo(() => decorateEdges(rfEdges, hovered), [rfEdges, hovered]);

  const measuredNodeSetKey = useMemo(
    () =>
      rfNodes
        .map((node) => `${node.id}:${node.type ?? ""}`)
        .sort()
        .join("\u0000"),
    [rfNodes],
  );
  const lastReportedSizes = useRef<ReadonlyMap<string, { width: number; height: number }> | null>(
    null,
  );
  useEffect(() => {
    if (!onMeasured || !nodesInitialized) return;
    // One animation frame lets React Flow commit its internal measurement
    // pass before we read it, and coalesces a burst of node initialization.
    const frame = requestAnimationFrame(() => {
      const sizes = new Map<string, { width: number; height: number }>();
      for (const node of getNodes()) {
        if ((node.type !== "leaf" && node.type !== "note") || isCodeChildId(node.id)) continue;
        const width = node.measured?.width;
        const height = node.measured?.height;
        if (width == null || height == null || !Number.isFinite(width) || !Number.isFinite(height)) {
          continue;
        }
        sizes.set(node.id, { width, height });
      }

      const previous = lastReportedSizes.current;
      const changed =
        !previous ||
        previous.size !== sizes.size ||
        [...sizes].some(([id, size]) => {
          const before = previous.get(id);
          return (
            !before ||
            Math.abs(before.width - size.width) > 1 ||
            Math.abs(before.height - size.height) > 1
          );
        });
      if (!changed) return;
      lastReportedSizes.current = sizes;
      onMeasured(sizes);
    });
    return () => cancelAnimationFrame(frame);
  }, [onMeasured, nodesInitialized, graph.id, measuredNodeSetKey, getNodes]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      let g = graphRef.current;
      let selection: Set<string> | null = null;
      let overrides: Map<string, { x: number; y: number }> | null = null;
      for (const change of changes) {
        switch (change.type) {
          case "position": {
            if (!change.position) break;
            // Also track architecture nodes while dragging: routed edges are
            // absolute polylines and must fall back to live RF geometry until
            // the drag commits its final pin/base position.
            overrides ??= new Map(dragOverrides);
            overrides.set(change.id, change.position);
            if (isCodeChildId(change.id)) {
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
      setCodeExpanded((prev) => new Map(prev).set(id, module));
      scheduleFocus(id);
    },
    [codeExpanded, moduleForNode, scheduleFocus],
  );

  /** Open/close a multi-part system's part tier ("Expand components"). */
  const toggleNodeParts = useCallback(
    (id: string) => {
      if (partsOpen.has(id)) {
        setPartsOpen((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        return;
      }
      // Parts and live code are alternate interiors of the same box — close
      // the code view first.
      if (codeExpanded.has(id)) {
        setCodeExpanded((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      }
      setPartsOpen((prev) => new Set(prev).add(id));
      scheduleFocus(id);
    },
    [partsOpen, codeExpanded, scheduleFocus],
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
      setDragOverrides(new Map());
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
          // Only the modules actually slotted on this canvas — `{}` means the
          // whole repo, which a large workspace cannot afford in one payload.
          const res = await client.request("codemap.details", {
            modules: [...new Set(adds.values())],
          });
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
          // Expand only what the per-module cap will show — expanding every
          // file marks them all `pinned`, defeats the cap and mounts the
          // whole repo's symbol chips at once.
          const shown = new Set(res.modules.flatMap((d) => cappedExpansionFiles(d)));
          setMemberCount(
            res.files.reduce(
              (n, f) => n + (shown.has(f.path) ? (f.symbols ?? f.exports).length : 0),
              0,
            ),
          );
          setExpandedFiles(shown);
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

  // A deep-linked ladder stop applies once the code map is in. `lod` is not a
  // URL field for this view — it bleeds over from the codebase view's nav
  // state — so on a huge tree it must not auto-apply at mount: a stale
  // "members" would bulk-load the canvas before the user asked for anything.
  const lodLevelInit = useRef(false);
  useEffect(() => {
    if (lodLevelInit.current || !codeSummary) return;
    lodLevelInit.current = true;
    if (codeSummary.fileTotal > HUGE_TREE_FILE_LIMIT) return;
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

  const onMoveEnd = useCallback(
    (_evt: unknown, viewport: Viewport) => {
      commit({ ...graphRef.current, viewport });
    },
    [commit],
  );

  // Switching facets reframes the view around what the lens shows.
  const lastFacetId = useRef(activeFacetId);
  useEffect(() => {
    if (lastFacetId.current === activeFacetId) return;
    lastFacetId.current = activeFacetId;
    const timer = setTimeout(() => void fitView({ padding: 0.15, duration: 300 }), 60);
    return () => clearTimeout(timer);
  }, [activeFacetId, fitView]);

  // Changing C4 altitude swaps in a differently-shaped diagram (the projected
  // graph's id carries the view key) — reframe around it, same as facets.
  const lastGraphId = useRef(graph.id);
  useEffect(() => {
    if (!c4 || lastGraphId.current === graph.id) return;
    lastGraphId.current = graph.id;
    const timer = setTimeout(() => void fitView({ padding: 0.15, duration: 300 }), 60);
    return () => clearTimeout(timer);
  }, [graph.id, c4, fitView]);

  const runAutoLayout = useCallback(
    (mode: "flow" | "layers" = "flow") => {
      if (onAutoLayout) {
        onAutoLayout();
      } else {
        // Dagre's non-C4 callers still need every card's footprint. Browser
        // system-card slots override deterministic estimates because their
        // semantic rows are taller than the generic card renderer.
        const reserve = estimateGraphDims(graphRef.current);
        for (const [id, size] of slotSizes) reserve.set(id, size);
        commit(autoLayoutFitted(graphRef.current, { mode, reserve }));
      }
      // Let the new positions render, then bring everything into view.
      requestAnimationFrame(() => void fitView({ padding: 0.15, duration: 300 }));
    },
    [commit, fitView, slotSizes, onAutoLayout],
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
      // C4 drill-down first: the system descends into containers, a
      // container into its components. Code expansion stays a double-click
      // away on everything without a drill target.
      const drillView = c4?.drill[node.id];
      if (drillView) {
        c4?.onDrill(drillView);
        return;
      }
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
    [c4, codeRefForNode, toggleFile, toggleCode, toggleNodeCode],
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
        ...(onAutoLayout
          ? ([
              {
                type: "item",
                label: "Auto layout",
                icon: LayoutGrid,
                onSelect: () => runAutoLayout("flow"),
              },
            ] satisfies MenuEntry[])
          : ([
              {
                type: "submenu",
                label: "Auto-layout",
                icon: LayoutGrid,
                entries: [
                  { type: "item", label: "Flow — top to bottom", icon: LayoutGrid, onSelect: () => runAutoLayout("flow") },
                  { type: "item", label: "Layers — by role (fullstack aware)", icon: Rows3, onSelect: () => runAutoLayout("layers") },
                ],
              },
            ] satisfies MenuEntry[])),
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

      // C4 aggregates (containers, the system, the derived user) re-derive on
      // every projection — deleting or duplicating one is meaningless, and
      // their first affordance is navigation between altitudes.
      const drillView = c4?.drill[node.id];
      const c4Aggregate =
        c4 != null &&
        (node.id.startsWith("ctr:") || node.id === "c4:system" || node.id === "person:user");
      const drillEntries: MenuEntry[] = drillView
        ? [
            {
              type: "item",
              label:
                drillView.level === "components"
                  ? "Open components"
                  : drillView.level === "containers"
                    ? "View containers"
                    : "View system context",
              icon: drillView.level === "context" ? Shrink : Expand,
              hint: "double-click",
              onSelect: () => c4?.onDrill(drillView),
            },
          ]
        : [];

      return [
        { type: "heading", label: node.label },
        ...drillEntries,
        ...(extraNodeEntries?.(node) ?? []),
        {
          type: "item",
          label: "Rename",
          icon: Pencil,
          onSelect: () => setRenaming({ x: menu.x, y: menu.y, id: node.id }),
        },
        {
          type: "item",
          label: "Duplicate",
          icon: Copy,
          disabled: c4Aggregate,
          onSelect: () => duplicateNode(node.id),
        },
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
        // Only multi-part systems open — a single part is the card itself.
        ...(partSystems?.has(node.id)
          ? [
              {
                type: "item",
                label: partsOpen.has(node.id) ? "Collapse components" : "Expand components",
                icon: partsOpen.has(node.id) ? Shrink : Expand,
                hint: partsOpen.has(node.id)
                  ? undefined
                  : `${partSystems.get(node.id)!.parts.length} parts`,
                onSelect: () => toggleNodeParts(node.id),
              } satisfies MenuEntry,
            ]
          : []),
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
          disabled: c4Aggregate,
          hint: c4Aggregate ? "derived — hide its components instead" : undefined,
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
        // Planned (ghost) files exist only in the draft — no cross-view block.
        ...(d.planned
          ? [
              {
                type: "item" as const,
                label: "Copy path",
                icon: Copy,
                hint: d.path.split("/").pop(),
                onSelect: () => void navigator.clipboard?.writeText(d.path),
              },
            ]
          : symbolMenu({ file: d.path, module: d.module, label: d.name })),
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
        // Planned (ghost) symbols exist only in the draft — no cross-view block.
        ...(d.planned
          ? []
          : symbolMenu(
              { file: d.file, symbol: d.name, module: d.module, label: d.name },
              {
                startJourney: onStartJourney && journeyable ? onStartJourney : undefined,
              },
            )),
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
    // Split boundary edges (part attribution) aren't graph edges — offer the
    // aggregate's contract instead of nothing.
    const splitBase = /^(link:.*)#\d+$/.exec(menu.id)?.[1];
    if (splitBase) {
      return [
        { type: "heading", label: "Boundary (part attribution)" },
        ...(onOpenContract
          ? [
              {
                type: "item",
                label: "View boundary contract",
                icon: FileText,
                onSelect: () => onOpenContract(splitBase),
              } satisfies MenuEntry,
            ]
          : []),
      ];
    }
    const edge = g.edges.find((e) => e.id === menu.id);
    if (!edge) return [];
    const endpointName = (id: string) => g.nodes.find((n) => n.id === id)?.label ?? "?";
    // A `c4rel:` edge aggregates the level's underlying links — it re-derives,
    // so kind/delete are meaningless; the contract drill (routed to the
    // heaviest member boundary by the host) is its real affordance.
    const c4Rel = edge.id.startsWith("c4rel:");
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
      ...(onOpenContract && (edge.id.startsWith("link:") || c4Rel)
        ? [
            {
              type: "item",
              label: "View boundary contract",
              icon: FileText,
              onSelect: () => onOpenContract(edge.id),
            } satisfies MenuEntry,
          ]
        : []),
      ...(c4Rel
        ? []
        : ([
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
          ] satisfies MenuEntry[])),
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
    onAutoLayout,
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
    symbolMenu,
    extraNodeEntries,
    onOpenContract,
    partSystems,
    partsOpen,
    toggleNodeParts,
    c4,
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

  /**
   * The selected node resolved against the overview: when it maps to a
   * system, the inspector renders the restored system detail sections
   * (parts, exports, routes, boundaries). Panels speak raw overview ids;
   * `canonicalOf` translates back to canvas node ids.
   */
  const selectedSystem = useMemo(() => {
    if (!overview || !selectedNode) return null;
    const idOfRaw = canonicalSystemIds(overview.systems);
    const system = overview.systems.find((s) => (idOfRaw.get(s.id) ?? s.id) === selectedNode.id);
    if (!system) return null;
    const names = new Map(overview.systems.map((s) => [s.id, s.name]));
    return {
      selection: {
        system,
        links: overview.links,
        nameOf: (raw: string) => names.get(raw) ?? raw,
      },
      canonicalOf: (raw: string) => idOfRaw.get(raw) ?? raw,
    };
  }, [overview, selectedNode]);

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
        nodes={displayNodes}
        edges={displayEdges}
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
        // Only viewport-visible nodes mount DOM — at members detail the full
        // scene is thousands of subtrees, fatal in the desktop webview.
        onlyRenderVisibleElements
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
        {/* React Flow panels have no width constraint of their own — cap it
            here so a fully-loaded toolbar wraps instead of running off the
            canvas (the right-side review cluster keeps its corner). */}
        <Panel position="top-left" className="max-w-[calc(100%-11rem)]">
          <div className="flex max-w-full flex-col items-start gap-2">
            {headerExtra}
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
              singleAutoLayout={onAutoLayout != null}
              onFitView={() => void fitView({ padding: 0.15, duration: 300 })}
              onRename={(name) => commit({ ...graphRef.current, name })}
              lodLevel={lodLevel}
              onLodLevelChange={setLodLevel}
              lodCounts={lodCounts}
              overlayOn={overlayOn}
              onToggleOverlay={onToggleOverlay}
              showDuplicates={showDuplicates}
              onToggleDuplicates={onToggleDuplicates}
              showFindings={showFindings}
              onToggleFindings={onToggleFindings}
              showChanges={showChanges}
              onToggleChanges={onToggleChanges}
              showInsights={showInsights}
              onToggleInsights={onToggleInsights}
              showContracts={showContracts}
              onToggleContracts={onToggleContracts}
              showScreens={showScreens}
              onToggleScreens={onToggleScreens}
              showData={showData}
              onToggleData={onToggleData}
              showEndpoints={showEndpoints}
              onToggleEndpoints={onToggleEndpoints}
              onOpenWorkspacesMap={onOpenWorkspacesMap}
            />
          </div>
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
          systemSel={selectedSystem?.selection ?? null}
          onFocusSystem={
            selectedSystem
              ? (raw) => focusNode(selectedSystem.canonicalOf(raw))
              : undefined
          }
          onOpenBoundary={
            selectedSystem && onOpenContract
              ? (l) => {
                  onOpenContract(
                    linkEdgeId(
                      selectedSystem.canonicalOf(l.source),
                      selectedSystem.canonicalOf(l.target),
                    ),
                  );
                }
              : undefined
          }
          onStartJourney={onStartJourney}
          onFocusNode={focusNode}
          onGraphChange={commit}
          onOpenContract={onOpenContract}
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
